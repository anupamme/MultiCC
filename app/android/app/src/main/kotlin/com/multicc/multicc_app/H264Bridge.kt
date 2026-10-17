package com.multicc.multicc_app

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * 「🖥 屏幕」高清流畅模式的 Android 解码器：MediaCodec 解 H.264，YUV420 → BGRA，
 * 再经 MethodChannel 交给 Flutter 页面（与 RFB 的 framebuffer 同一格式）。
 *
 * 通道协议见 app/lib/services/platform_h264_decoder.dart：
 *   Dart → 原生  create / decode {bytes, pts, key, width, height} / dispose
 *   原生 → Dart  frame {bytes(BGRA), width, height, seq}
 *                error {message}   ← 积压/解码失败，前端据此重新要关键帧
 *
 * 解码输出统一降到 ≤1280 宽，避免 5K Retina 原始尺寸在手机端每帧搬运几十 MB。
 */
class H264Bridge(messenger: BinaryMessenger) : MethodChannel.MethodCallHandler {
    companion object {
        private const val MAX_WIDTH = 1280
        private const val CHANNEL = "com.multicc.multicc_app/h264"
    }

    private val channel = MethodChannel(messenger, CHANNEL)
    private val main = Handler(Looper.getMainLooper())
    private val thread = HandlerThread("multicc-h264").apply { start() }
    private val worker = Handler(thread.looper)
    private val pending = AtomicInteger(0)
    private val closed = AtomicBoolean(false)

    // 通道是 App 级单例，而 Dart 每开一次「🖥 屏幕」都会 create/dispose 一次解码器。
    // epoch 用来作废旧会话还排在 worker 队列里的任务；create 时重新放行。
    private val epoch = AtomicInteger(0)

    // 只在 worker 线程访问。
    private var codec: MediaCodec? = null
    private var csdKey: String? = null
    private var width = 0
    private var height = 0
    private var seq = 0

    // BT.709 limited-range 查表（H.264 HD 的常见标记），结果按 1/64 缩放。
    private val yTab = IntArray(256) { ((1.164 * (it - 16)) * 64).toInt().coerceAtLeast(0) }
    private val rvTab = IntArray(256) { (1.793 * (it - 128) * 64).toInt() }
    private val guTab = IntArray(256) { (-0.213 * (it - 128) * 64).toInt() }
    private val gvTab = IntArray(256) { (-0.533 * (it - 128) * 64).toInt() }
    private val buTab = IntArray(256) { (2.112 * (it - 128) * 64).toInt() }

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "create" -> {
                // 新会话：放行 + 换 epoch，并清掉上一轮可能残留的 codec。
                closed.set(false)
                val e = epoch.incrementAndGet()
                worker.post {
                    if (epoch.get() == e) releaseCodec()
                }
                result.success(hasAvcDecoder())
            }
            "decode" -> {
                val bytes = call.argument<ByteArray>("bytes")
                if (bytes == null || bytes.isEmpty()) {
                    result.success(null)
                    return
                }
                val key = call.argument<Boolean>("key") ?: false
                val pts = (call.argument<Number>("pts") ?: 0).toLong()
                val w = (call.argument<Number>("width") ?: 0).toInt()
                val h = (call.argument<Number>("height") ?: 0).toInt()
                if (closed.get()) {
                    result.success(null)
                    return
                }
                // 积压超过 2 帧就丢普通帧，让前端重关键帧——和 Web 端同一策略。
                if (!key && pending.get() > 2) {
                    notifyNeedKey()
                    result.success(null)
                    return
                }
                val e = epoch.get()
                pending.incrementAndGet()
                worker.post {
                    try {
                        if (epoch.get() != e || closed.get()) return@post
                        feed(bytes, key, pts, w, h)
                        drain()
                    } catch (_: Exception) {
                        resetCodec()
                        notifyNeedKey()
                    } finally {
                        pending.decrementAndGet()
                    }
                }
                result.success(null)
            }
            "dispose" -> {
                closed.set(true)
                epoch.incrementAndGet()
                worker.post { releaseCodec() }
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun hasAvcDecoder(): Boolean = try {
        MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
            !info.isEncoder && info.supportedTypes.any { it.equals("video/avc", true) }
        }
    } catch (_: Exception) {
        false
    }

    private fun feed(data: ByteArray, key: Boolean, pts: Long, w: Int, h: Int) {
        val c = ensureCodec(data, key, w, h) ?: run {
            if (!key) notifyNeedKey()
            return
        }
        val index = c.dequeueInputBuffer(10_000)
        if (index < 0) {
            notifyNeedKey()
            return
        }
        val buffer = c.getInputBuffer(index) ?: return
        buffer.clear()
        buffer.put(data)
        val flags = if (key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
        c.queueInputBuffer(index, 0, data.size, pts, flags)
    }

    private fun drain() {
        val c = codec ?: return
        val info = MediaCodec.BufferInfo()
        while (true) {
            val out = try {
                c.dequeueOutputBuffer(info, 0)
            } catch (_: Exception) {
                resetCodec()
                return
            }
            when {
                out >= 0 -> {
                    try {
                        if (info.size > 0) emitFrame(c, out)
                    } finally {
                        try {
                            c.releaseOutputBuffer(out, false)
                        } catch (_: Exception) {
                            resetCodec()
                            return
                        }
                    }
                }
                out == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val f = c.outputFormat
                    width = f.getInteger(MediaFormat.KEY_WIDTH)
                    height = f.getInteger(MediaFormat.KEY_HEIGHT)
                }
                else -> return
            }
        }
    }

    private fun ensureCodec(data: ByteArray, key: Boolean, w: Int, h: Int): MediaCodec? {
        codec?.let { existing ->
            if (key) {
                val fp = parameterFingerprint(data)
                if (fp != null && fp != csdKey) {
                    releaseCodec()
                } else {
                    return existing
                }
            } else {
                return existing
            }
        }
        if (!key) return null
        val nals = splitAnnexB(data)
        val sps = nals.firstOrNull { it.type == 7 }?.bytes ?: return null
        val pps = nals.firstOrNull { it.type == 8 }?.bytes ?: return null
        csdKey = "${sps.size}:${pps.size}:${sps.firstOrNull()}:${pps.firstOrNull()}"
        width = if (w > 0) w else 1920
        height = if (h > 0) h else 1080
        val format = MediaFormat.createVideoFormat("video/avc", width, height)
        format.setByteBuffer("csd-0", ByteBuffer.wrap(sps))
        format.setByteBuffer("csd-1", ByteBuffer.wrap(pps))
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
        return try {
            val c = MediaCodec.createDecoderByType("video/avc")
            c.configure(format, null, null, 0)
            c.start()
            codec = c
            c
        } catch (_: Exception) {
            notifyNeedKey()
            null
        }
    }

    private fun parameterFingerprint(data: ByteArray): String? {
        val nals = splitAnnexB(data)
        val sps = nals.firstOrNull { it.type == 7 }?.bytes ?: return null
        val pps = nals.firstOrNull { it.type == 8 }?.bytes ?: return null
        return "${sps.size}:${pps.size}:${sps.firstOrNull()}:${pps.firstOrNull()}"
    }

    private fun releaseCodec() {
        val c = codec
        codec = null
        csdKey = null
        if (c != null) {
            try {
                c.stop()
            } catch (_: Exception) {
            }
            try {
                c.release()
            } catch (_: Exception) {
            }
        }
    }

    private fun resetCodec() {
        releaseCodec()
    }

    private fun emitFrame(c: MediaCodec, index: Int) {
        val image = try {
            c.getOutputImage(index)
        } catch (_: Exception) {
            null
        } ?: return
        val sw = image.width
        val sh = image.height
        if (sw <= 0 || sh <= 0) return
        val dw = if (sw > MAX_WIDTH) MAX_WIDTH else sw
        val dh = if (dw == sw) sh else maxOf(2, (sh * dw / sw))
        val out = ByteArray(dw * dh * 4)

        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]
        val yBuf = yPlane.buffer
        val uBuf = uPlane.buffer
        val vBuf = vPlane.buffer
        val yRow = yPlane.rowStride
        val yPix = yPlane.pixelStride
        val uRow = uPlane.rowStride
        val uPix = uPlane.pixelStride
        val vRow = vPlane.rowStride
        val vPix = vPlane.pixelStride

        for (y in 0 until dh) {
            val sy = y * sh / dh
            val yBase = sy * yRow
            val cBaseU = (sy / 2) * uRow
            val cBaseV = (sy / 2) * vRow
            var p = y * dw * 4
            for (x in 0 until dw) {
                val sx = x * sw / dw
                val yv = yBuf.get(yBase + sx * yPix).toInt() and 0xFF
                val ui = cBaseU + (sx / 2) * uPix
                val vi = cBaseV + (sx / 2) * vPix
                val u = uBuf.get(ui).toInt() and 0xFF
                val v = vBuf.get(vi).toInt() and 0xFF
                val yy = yTab[yv]
                val r = (yy + rvTab[v]) shr 6
                val g = (yy + guTab[u] + gvTab[v]) shr 6
                val b = (yy + buTab[u]) shr 6
                out[p] = clamp(b)
                out[p + 1] = clamp(g)
                out[p + 2] = clamp(r)
                out[p + 3] = -1
                p += 4
            }
        }

        seq += 1
        val args = HashMap<String, Any>()
        args["bytes"] = out
        args["width"] = dw
        args["height"] = dh
        args["seq"] = seq
        main.post {
            if (!closed.get()) channel.invokeMethod("frame", args)
        }
    }

    private fun clamp(v: Int): Byte = when {
        v < 0 -> 0
        v > 255 -> -1 // 0xFF
        else -> v.toByte()
    }

    private fun notifyNeedKey() {
        main.post {
            if (!closed.get()) {
                channel.invokeMethod("error", hashMapOf("message" to "decode-need-key"))
            }
        }
    }

    private class Nal(val type: Int, val bytes: ByteArray)

    /** Annex B 拆 NAL；返回的 bytes 保留原起始码（MediaCodec csd 需要）。 */
    private fun splitAnnexB(data: ByteArray): List<Nal> {
        val marks = ArrayList<IntArray>() // [codeStart, payloadStart]
        var i = 0
        while (i + 3 <= data.size) {
            if (i + 4 <= data.size &&
                data[i] == 0.toByte() && data[i + 1] == 0.toByte() &&
                data[i + 2] == 0.toByte() && data[i + 3] == 1.toByte()
            ) {
                marks.add(intArrayOf(i, i + 4))
                i += 4
            } else if (data[i] == 0.toByte() && data[i + 1] == 0.toByte() && data[i + 2] == 1.toByte()) {
                marks.add(intArrayOf(i, i + 3))
                i += 3
            } else {
                i += 1
            }
        }
        val out = ArrayList<Nal>(marks.size)
        for (k in marks.indices) {
            val payload = marks[k][1]
            val end = if (k + 1 < marks.size) marks[k + 1][0] else data.size
            if (payload >= end) continue
            val type = data[payload].toInt() and 0x1F
            out.add(Nal(type, data.copyOfRange(marks[k][0], end)))
        }
        return out
    }
}
