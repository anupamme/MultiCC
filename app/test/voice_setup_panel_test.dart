// 「语音输入还没准备好」：点麦克风先问服务端；本地模型没装、也没配云端时
// 弹安装面板（不再先录一整段再报 STT failed: 503），面板里能直接下载，
// 并跟着 /api/voice/readiness 看进度直到「已就绪」。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/manage_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/services/voice_clip_recorder.dart';
import 'package:multicc_app/services/voice_dictation_service.dart';
import 'package:multicc_app/widgets/voice_composer.dart';
import 'package:multicc_app/widgets/voice_setup_panel.dart';

class _Clip implements VoiceClipRecording {
  bool started = false;
  @override
  bool get isRecording => started;
  @override
  bool get isTranscribing => false;
  @override
  Future<bool> start() async => started = true;
  @override
  Future<String> stopAndTranscribe(SettingsService settings) async => '';
  @override
  Future<void> cancel() async {}
  @override
  void dispose() {}
}

Future<SettingsService> _settings() async {
  SharedPreferences.setMockInitialValues({
    'multicc_host': 'http://127.0.0.1:1',
    'multicc_token': '',
  });
  return SettingsService.getInstance();
}

Map<String, dynamic> _readiness(String state, {double percent = 0}) => {
  'ready': state == 'ready',
  'engine': state == 'ready' ? 'local' : null,
  'reason': state == 'ready' ? null : state,
  'cloudConfigured': false,
  'download': {
    'state': state,
    'percent': percent,
    'totalBytes': 240193589,
    'doneBytes': (240193589 * percent / 100).round(),
    'bytesPerSec': state == 'downloading' ? 5242880 : 0,
    'etaSec': state == 'downloading' ? 30 : 0,
  },
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() => I18n.init('zh'));

  tearDown(() {
    VoiceComposerController.debugDictationBuilder = null;
    VoiceComposerController.debugClipBuilder = null;
    VoiceComposerController.debugReadinessProbe = null;
  });

  testWidgets('面板：点「下载离线模型」→ 进度条与速度 → 装好后说可以用了', (tester) async {
    final settings = await _settings();
    var state = 'missing';
    var percent = 0.0;
    final posted = <String>[];
    final client = MockClient((req) async {
      if (req.url.path == '/api/settings/voice/asr-model') {
        posted.add((jsonDecode(req.body) as Map)['action'] as String);
        state = 'downloading';
        percent = 40;
        return http.Response(jsonEncode({'ok': true}), 200);
      }
      return http.Response(
        jsonEncode(_readiness(state, percent: percent)),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    });
    final manage = ManageService(settings: settings, httpClient: client);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: VoiceSetupPanel(manage: manage)),
      ),
    );
    await tester.pump();
    expect(find.text(t('voiceGuideTitle')), findsOneWidget);
    expect(find.text(t('voiceGuideDownload')), findsOneWidget);
    expect(find.text(t('voiceGuideCloudOnWeb')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('voice-setup-action')));
    await tester.pump();
    await tester.pump();
    expect(posted, ['download']);
    expect(find.byKey(const ValueKey('voice-setup-progress')), findsOneWidget);
    expect(find.textContaining('40'), findsOneWidget);
    expect(find.text(t('airVoiceLocalCancel')), findsOneWidget);

    // 下一轮轮询：服务端说装好了。
    state = 'ready';
    await tester.pump(const Duration(milliseconds: 1600));
    await tester.pump();
    expect(find.text(t('voiceGuideReadyTitle')), findsOneWidget);
    expect(find.text(t('voiceGuideReadyDesc')), findsOneWidget);
    expect(find.byKey(const ValueKey('voice-setup-progress')), findsNothing);

    // 已就绪后不再轮询：再等一轮不应有新请求打到下载接口，也不留计时器。
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('取消按钮发的是 cancel，不是又一次 download', (tester) async {
    final settings = await _settings();
    final posted = <String>[];
    final client = MockClient((req) async {
      if (req.url.path == '/api/settings/voice/asr-model') {
        posted.add((jsonDecode(req.body) as Map)['action'] as String);
        return http.Response(jsonEncode({'ok': true}), 200);
      }
      return http.Response(
        jsonEncode(_readiness('downloading', percent: 10)),
        200,
      );
    });
    final manage = ManageService(settings: settings, httpClient: client);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: VoiceSetupPanel(
            manage: manage,
            initial: _readiness('downloading', percent: 10),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('voice-setup-action')));
    await tester.pump();
    await tester.pump();
    expect(posted, ['cancel']);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('点麦克风：语音没准备好就直接弹安装面板，不开始听写也不录音', (tester) async {
    final settings = await _settings();
    var dictationBuilt = 0;
    final clip = _Clip();
    VoiceComposerController.debugDictationBuilder = (s) {
      dictationBuilt++;
      return VoiceDictationService(settings: s, micOpener: (_) async => null);
    };
    VoiceComposerController.debugClipBuilder = () => clip;
    VoiceComposerController.debugReadinessProbe = (_) async =>
        _readiness('missing');

    final controller = TextEditingController();
    final voice = VoiceComposerController(
      target: controller,
      settings: settings,
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => voice.toggleMic(context),
              child: const Text('mic'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('mic'));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('voice-setup-panel')), findsOneWidget);
    expect(find.text(t('voiceGuideDownload')), findsOneWidget);
    expect(dictationBuilt, 0, reason: '没准备好就不该开始听写');
    expect(clip.started, isFalse, reason: '也不该退回整段录音');

    await tester.pumpWidget(const SizedBox.shrink());
    voice.dispose();
    controller.dispose();
  });
}
