// iOS/Android 原生 H.264 解码的端到端集成测试（真机或模拟器上跑）。
//
// 不依赖 MultiCC 服务端与 Agent：测试从本机 fixture 服务取一段 ffmpeg 造的
// Annex B 码流，按 App 的通道协议直接喂给平台解码器，断言解出 BGRA 帧。
//
// 跑之前先在 Mac 上起 fixture：
//   mkdir -p /tmp/h264-fixture && cd /tmp/h264-fixture
//   ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=30:duration=2 \
//     -c:v libx264 -profile:v main -pix_fmt yuv420p -g 30 -x264-params aud=1 \
//     -f h264 sample_320x240.h264
//   ffmpeg -y -f lavfi -i testsrc2=size=1600x900:rate=10:duration=0.5 \
//     -c:v libx264 -profile:v main -pix_fmt yuv420p -g 5 -x264-params aud=1 \
//     -f h264 sample_1600x900.h264
//   python3 -m http.server 18765 --directory /tmp/h264-fixture
// 然后：
//   flutter test integration_test/h264_decoder_test.dart -d <simulator-or-device>
//
// 第一个用例只验证原生解码，只需要 fixture 服务。
// 第二个用例验证完整 App 传输链路（capabilities → ws-ticket → 中继 WS → 解码 →
// 输入回传）：测试进程自己起一个假服务端推同一段码流，不依赖本机 MultiCC
// 服务端版本与登录态，只额外需要 fixture 服务（取码流）。
// 只跑第一个可用 --plain-name。
//
// 192.0.2.1 只是占位；实际地址用 --dart-define=H264_FIXTURE_URL=... 覆盖。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:multicc_app/services/platform_h264_decoder.dart';
import 'package:multicc_app/services/remote_screen_h264.dart';
import 'package:multicc_app/services/remote_screen_service.dart';
import 'package:multicc_app/services/settings_service.dart';

const String _fixtureBase = String.fromEnvironment(
  'H264_FIXTURE_URL',
  defaultValue: 'http://127.0.0.1:18765',
);

/// 一个 access unit：AUD 开头，到下一个 AUD 为止；关键帧里含 IDR（type 5）。
class _Au {
  _Au(this.bytes, this.key);
  final Uint8List bytes;
  final bool key;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('VideoToolbox/MediaCodec 解真实码流并回传 BGRA', (tester) async {
    final decoder = PlatformH264Decoder.create();
    expect(decoder, isNotNull, reason: '平台不是 iOS/Android 时本测试不适用');
    expect(await decoder!.open(), isTrue, reason: '原生 create 失败');

    final frames = <H264Frame>[];
    final errors = <String>[];
    final frameSub = decoder.frames.listen(frames.add);
    final errSub = decoder.errors.listen(errors.add);
    addTearDown(() async {
      await frameSub.cancel();
      await errSub.cancel();
      await decoder.close();
    });

    final bytes = (await tester.runAsync(
      () => _fetch('$_fixtureBase/sample_320x240.h264'),
    ))!;
    final aus = _splitAccessUnits(bytes);
    expect(aus.where((au) => au.key), isNotEmpty, reason: 'fixture 里没有关键帧');

    await _feed(tester, decoder, aus, 320, 240);
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 600)),
    );

    expect(errors, isEmpty, reason: '解码器报了错：$errors');
    expect(frames, isNotEmpty, reason: '没有解出任何帧');
    final first = frames.first;
    expect(first.width, 320);
    expect(first.height, 240);
    expect(first.bytes.length, 320 * 240 * 4);
    expect(
      first.bytes.where((b) => b != 0).length,
      greaterThan(1000),
      reason: '解出的 BGRA 帧是空的',
    );
    // 不透明黑之外要有内容：alpha 应全为 255。
    var opaque = 0;
    for (var i = 3; i < first.bytes.length; i += 4) {
      if (first.bytes[i] == 255) opaque += 1;
    }
    expect(opaque, greaterThan(320 * 240 ~/ 2), reason: 'alpha 不是 255');

    // 再喂一段更宽的画面，验证原生侧降到 ≤1280 宽。
    final wide = (await tester.runAsync(
      () => _fetch('$_fixtureBase/sample_1600x900.h264'),
    ))!;
    frames.clear();
    await _feed(tester, decoder, _splitAccessUnits(wide), 1600, 900);
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 800)),
    );
    expect(errors, isEmpty, reason: '宽画面解码报错：$errors');
    expect(frames, isNotEmpty, reason: '宽画面没有解出帧');
    expect(frames.last.width, 1280);
    expect(frames.last.height, 720);
    expect(frames.last.bytes.length, 1280 * 720 * 4);
  });

  // 完整 App 链路：capabilities → ws-ticket → ?mode=h264 中继 → 原生解码。
  // 假服务端起在测试进程自己的 loopback 上，不依赖本机 MultiCC 服务端版本。
  testWidgets('App 传输链路端到端：ticket + WS 帧流 + 原生解码 + 输入回传', (tester) async {
    final bytes = (await tester.runAsync(
      () => _fetch('$_fixtureBase/sample_320x240.h264'),
    ))!;
    final aus = _splitAccessUnits(bytes);
    expect(aus.where((au) => au.key), isNotEmpty);

    final server = _FakeScreenServer(aus, 320, 240);
    await tester.runAsync(server.start);
    addTearDown(server.close);

    final settings = (await tester.runAsync(SettingsService.getInstance))!;
    final oldHost = settings.host;
    final oldToken = settings.token;
    await tester.runAsync(
      () => settings.save(
        host: 'http://127.0.0.1:${server.port}',
        token: 'integration-test',
      ),
    );
    addTearDown(() => settings.save(host: oldHost, token: oldToken));

    final svc = RemoteScreenService(settings: settings);
    var frames = 0;
    final sub = svc.onFrame.listen((_) => frames += 1);
    addTearDown(() async {
      await sub.cancel();
      svc.dispose();
    });

    svc.connectLive();
    final deadline = DateTime.now().add(const Duration(seconds: 20));
    while (DateTime.now().isBefore(deadline)) {
      final src = svc.source;
      if (svc.mode == RemoteScreenMode.live &&
          svc.h264Active &&
          src != null &&
          src.framebuffer != null &&
          frames > 0) {
        break;
      }
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 100)),
      );
    }

    expect(
      svc.h264Active,
      isTrue,
      reason: '没有走 H.264（mode=${svc.mode} error=${svc.error}）',
    );
    expect(svc.mode, RemoteScreenMode.live);
    final src = svc.source!;
    expect(src.width, 320);
    expect(src.height, 240);
    expect(src.framebuffer!.length, 320 * 240 * 4);
    expect(frames, greaterThan(0));

    // 输入走同一条 WS，线上编码必须还是 RFB PointerEvent。
    src.pointerEvent(1, 10, 20);
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 150)),
    );
    expect(
      server.clientMessages,
      contains(equals(<int>[5, 1, 0, 10, 0, 20])),
      reason: '输入没有按协议到达服务端：${server.clientMessages}',
    );
  });
}

/// 只实现 RemoteScreenService 用到的三个端点：能力、换票、H.264 WS。
class _FakeScreenServer {
  _FakeScreenServer(this.aus, this.width, this.height);

  final List<_Au> aus;
  final int width;
  final int height;
  final List<List<int>> clientMessages = <List<int>>[];
  HttpServer? _server;

  int get port => _server!.port;

  Future<void> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server = server;
    server.listen(_handle);
  }

  Future<void> close() async {
    await _server?.close(force: true);
    _server = null;
  }

  Future<void> _handle(HttpRequest req) async {
    if (req.uri.path == '/api/remote-screen/capabilities') {
      await _json(req, {
        'ok': true,
        'supported': true,
        'platform': 'darwin',
        'streams': {'h264': true, 'rfb': false},
        'features': {'stream': true},
      });
      return;
    }
    if (req.uri.path == '/api/auth/ws-ticket') {
      await req.drain<void>();
      await _json(req, {
        'ticket': 'integration-test-ticket',
        'path': '/ws/remote-screen',
      });
      return;
    }
    if (req.uri.path == '/ws/remote-screen') {
      final ws = await WebSocketTransformer.upgrade(req);
      _pump(ws);
      return;
    }
    req.response.statusCode = 404;
    await req.response.close();
  }

  Future<void> _json(HttpRequest req, Map<String, Object?> body) async {
    req.response.headers.contentType = ContentType.json;
    req.response.write(jsonEncode(body));
    await req.response.close();
  }

  void _pump(WebSocket ws) {
    ws.add(
      _frame(
        h264Config,
        utf8.encode(jsonEncode({'codec': 'avc1.4D401E', 'width': width, 'height': height})),
      ),
    );
    var i = 0;
    final timer = Timer.periodic(const Duration(milliseconds: 100), (t) {
      if (i >= aus.length * 2 || ws.readyState != WebSocket.open) {
        t.cancel();
        return;
      }
      final au = aus[i % aus.length];
      final head = ByteData(8)
        ..setUint64(0, DateTime.now().microsecondsSinceEpoch, Endian.big);
      ws.add(
        _frame(
          au.key ? h264Key : h264Delta,
          Uint8List.fromList([...head.buffer.asUint8List(), ...au.bytes]),
        ),
      );
      i += 1;
    });
    ws.listen(
      (dynamic data) {
        if (data is List<int>) clientMessages.add(List<int>.from(data));
      },
      onDone: timer.cancel,
      onError: (Object _) => timer.cancel(),
    );
  }
}

Uint8List _frame(int type, List<int> payload) {
  final out = Uint8List(5 + payload.length);
  out[0] = type;
  out[1] = (payload.length >> 24) & 0xFF;
  out[2] = (payload.length >> 16) & 0xFF;
  out[3] = (payload.length >> 8) & 0xFF;
  out[4] = payload.length & 0xFF;
  out.setRange(5, out.length, payload);
  return out;
}

Future<void> _feed(
  WidgetTester tester,
  H264Decoder decoder,
  List<_Au> aus,
  int width,
  int height,
) async {
  for (var i = 0; i < aus.length; i++) {
    decoder.decode(
      aus[i].bytes,
      timestampUs: i * 33333,
      key: aus[i].key,
      width: width,
      height: height,
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 35)),
    );
  }
}

Future<Uint8List> _fetch(String url) async {
  final client = HttpClient();
  try {
    final res = await client.getUrl(Uri.parse(url));
    final body = await res.close();
    if (body.statusCode != 200) {
      throw StateError('fixture HTTP ${body.statusCode}: $url');
    }
    final chunks = <int>[];
    await for (final chunk in body) {
      chunks.addAll(chunk);
    }
    return Uint8List.fromList(chunks);
  } finally {
    client.close();
  }
}

/// Annex B 切 access unit（fixture 用 x264 的 aud=1，每个 AU 以 AUD 开头）。
/// 首个 AUD 之前的 SPS/PPS 归到第一个 AU 里，后面跟着的 IDR 才算关键帧。
List<_Au> _splitAccessUnits(Uint8List bytes) {
  final marks = <(int, int)>[]; // (start code 起点, NAL 载荷起点)
  var i = 0;
  while (i + 3 <= bytes.length) {
    final four =
        i + 4 <= bytes.length &&
        bytes[i] == 0 &&
        bytes[i + 1] == 0 &&
        bytes[i + 2] == 0 &&
        bytes[i + 3] == 1;
    final three =
        bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1;
    if (four) {
      marks.add((i, i + 4));
      i += 4;
    } else if (three) {
      marks.add((i, i + 3));
      i += 3;
    } else {
      i += 1;
    }
  }
  if (marks.isEmpty) return const [];

  final audStarts = <int>[];
  for (var k = 0; k < marks.length; k++) {
    if ((bytes[marks[k].$2] & 0x1F) == 9) audStarts.add(marks[k].$1);
  }
  // 没有 AUD 就整段当一个 AU。
  if (audStarts.isEmpty) {
    final key = marks.any((m) => (bytes[m.$2] & 0x1F) == 5);
    return [
      _Au(Uint8List.sublistView(bytes, 0, bytes.length), key),
    ];
  }

  final out = <_Au>[];
  for (var a = 0; a < audStarts.length; a++) {
    final start = a == 0 ? 0 : audStarts[a];
    final end = a + 1 < audStarts.length ? audStarts[a + 1] : bytes.length;
    // 第一个 AU 从 0 开始，自然带上开头的 SPS/PPS。
    final payload = Uint8List.sublistView(bytes, start, end);
    var key = false;
    var j = start;
    final stop = end;
    while (j + 3 <= stop) {
      final four =
          j + 4 <= stop &&
          bytes[j] == 0 &&
          bytes[j + 1] == 0 &&
          bytes[j + 2] == 0 &&
          bytes[j + 3] == 1;
      final three = bytes[j] == 0 && bytes[j + 1] == 0 && bytes[j + 2] == 1;
      final typeOffset = four
          ? j + 4
          : three
          ? j + 3
          : -1;
      if (typeOffset >= 0 && typeOffset < stop) {
        if ((bytes[typeOffset] & 0x1F) == 5) {
          key = true;
          break;
        }
        j = typeOffset;
      } else {
        j += 1;
      }
    }
    out.add(_Au(payload, key));
  }
  return out;
}
