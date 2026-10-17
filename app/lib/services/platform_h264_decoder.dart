import 'dart:async';
import 'dart:io' as io;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'remote_screen_h264.dart';

/// H.264 平台解码器（iOS VideoToolbox / Android MediaCodec）。
///
/// 通道：`com.multicc.multicc_app/h264`
///   Dart → 原生  create / decode {bytes, pts, key, width, height} / dispose
///   原生 → Dart  frame {bytes(BGRA), width, height, seq, key}
///                error {message}
///
/// 原生侧负责把帧降到 ≤1280 宽，BGRA 回传；页面按 4 字节/像素直接画，
/// 与 RFB 的 framebuffer 同一路径。
class PlatformH264Decoder implements H264Decoder {
  PlatformH264Decoder({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(platformH264Channel) {
    _channel.setMethodCallHandler(_onCall);
  }

  static const String platformH264Channel = 'com.multicc.multicc_app/h264';

  /// 只有移动端有解码插件；桌面/Web 端一律回落到 RFB。
  static H264Decoder? create() {
    if (kIsWeb) return null;
    if (!io.Platform.isIOS && !io.Platform.isAndroid) return null;
    return PlatformH264Decoder();
  }

  final MethodChannel _channel;
  final StreamController<H264Frame> _frames =
      StreamController<H264Frame>.broadcast();
  final StreamController<String> _errors = StreamController<String>.broadcast();
  bool _closed = false;

  @override
  Stream<H264Frame> get frames => _frames.stream;

  @override
  Stream<String> get errors => _errors.stream;

  @override
  Future<bool> open() async {
    try {
      final ok = await _channel.invokeMethod<bool>('create');
      return ok == true;
    } catch (_) {
      return false; // 未注册插件 / 平台不支持
    }
  }

  @override
  void decode(
    Uint8List annexB, {
    required int timestampUs,
    required bool key,
    required int width,
    required int height,
  }) {
    if (_closed) return;
    _channel
        .invokeMethod<void>('decode', <String, dynamic>{
          'bytes': annexB,
          'pts': timestampUs,
          'key': key,
          'width': width,
          'height': height,
        })
        .then<void>((_) {}, onError: (Object _) {});
  }

  Future<dynamic> _onCall(MethodCall call) async {
    if (_closed) return null;
    final args = call.arguments;
    if (call.method == 'frame' && args is Map) {
      final bytes = args['bytes'];
      final w = (args['width'] as num?)?.toInt() ?? 0;
      final h = (args['height'] as num?)?.toInt() ?? 0;
      if (bytes is Uint8List && w > 0 && h > 0) {
        _frames.add(
          H264Frame(
            bytes: bytes,
            width: w,
            height: h,
            key: args['key'] == true,
          ),
        );
      }
    } else if (call.method == 'error') {
      final message = args is Map ? '${args['message'] ?? ''}' : '$args';
      _errors.add(message.isEmpty ? 'decode-failed' : message);
    }
    return null;
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    try {
      await _channel.invokeMethod<void>('dispose');
    } catch (_) {}
    _channel.setMethodCallHandler(null);
    await _frames.close();
    await _errors.close();
  }
}
