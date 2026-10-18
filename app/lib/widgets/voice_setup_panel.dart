import 'dart:async';

import 'package:flutter/material.dart';

import '../i18n.dart';
import '../screens/voice_settings_screen.dart';
import '../services/manage_service.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import '../utils/format.dart';

/// 「语音输入还没准备好」—— 本地离线模型的安装面板（对应网页 voice-readiness.js）。
///
/// 两处用它：点麦克风时服务端说用不了（[showVoiceSetupSheet] 弹底部面板），以及语音
/// 设置页顶上那一格。面板自己问 `GET /api/voice/readiness`，能下载就给一颗「下载离线
/// 模型」，下载中每 1.5 秒刷新进度 / 速度 / 剩余时间，装好了就说「再点一次麦克风」。
/// 云端 Key 属于密钥，手机端不处理，只提示去网页填（与语音设置页的约定一致）。
class VoiceSetupPanel extends StatefulWidget {
  const VoiceSetupPanel({
    super.key,
    required this.manage,
    this.initial,
    this.onOpenSettings,
    this.hideWhenReady = false,
  });

  final ManageService manage;

  /// 调用方手里已有的那份 readiness（例如 STT 503 回来的），省一次往返。
  final Map<String, dynamic>? initial;

  /// 非空时多一颗「语音设置」按钮（底部面板里用；设置页本身不需要）。
  final VoidCallback? onOpenSettings;

  /// 设置页里：已经能用就整格不画，别占位置。
  final bool hideWhenReady;

  @override
  State<VoiceSetupPanel> createState() => _VoiceSetupPanelState();
}

class _VoiceSetupPanelState extends State<VoiceSetupPanel> {
  static const _pollEvery = Duration(milliseconds: 1500);

  Map<String, dynamic>? _r;
  Timer? _poll;
  bool _busy = false;
  String? _actionError;

  @override
  void initState() {
    super.initState();
    _r = widget.initial;
    // 调用方刚问过的那份就是最新的；只有在下载中才需要马上开始跟进度。
    if (_r == null || _reason == 'downloading') _refresh();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Map<String, dynamic> get _download =>
      ((_r?['download'] as Map?) ?? const {}).cast<String, dynamic>();

  bool get _ready => _r?['ready'] == true;

  String get _reason =>
      _ready ? 'ready' : (_r?['reason'] ?? 'missing').toString();

  Future<void> _refresh() async {
    try {
      final r = await widget.manage.fetchVoiceReadiness();
      if (!mounted) return;
      setState(() => _r = r);
    } catch (_) {
      // 读不到就保留上一份；轮询下一轮再试。
    }
    if (!mounted) return;
    if (_reason == 'downloading') {
      _poll ??= Timer.periodic(_pollEvery, (_) => _refresh());
    } else {
      _poll?.cancel();
      _poll = null;
    }
  }

  Future<void> _act(String action) async {
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      await widget.manage.localAsrModelAction(action);
    } catch (e) {
      if (mounted) {
        setState(
          () => _actionError = t('airVoiceLocalActionFailed', {'error': '$e'}),
        );
      }
    }
    if (mounted) setState(() => _busy = false);
    await _refresh();
  }

  String _progressText() {
    final dl = _download;
    int n(String k) => (dl[k] is num) ? (dl[k] as num).round() : 0;
    final parts = <String>[
      t('airVoiceLocalProgress', {
        'percent': '${dl['percent'] ?? 0}',
        'done': formatBytes(n('doneBytes')),
        'total': formatBytes(n('totalBytes')),
      }),
    ];
    if (n('bytesPerSec') > 0) {
      parts.add(
        t('airVoiceLocalSpeed', {'value': formatBytes(n('bytesPerSec'))}),
      );
    }
    final eta = n('etaSec');
    if (eta > 0) {
      parts.add(
        eta >= 60
            ? t('airVoiceLocalEtaMin', {
                'm': '${eta ~/ 60}',
                's': '${eta % 60}',
              })
            : t('airVoiceLocalEtaSec', {'n': '$eta'}),
      );
    }
    return parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    if (_r == null) {
      return widget.hideWhenReady
          ? const SizedBox.shrink()
          : const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: CircularProgressIndicator()),
            );
    }
    if (_ready && widget.hideWhenReady) return const SizedBox.shrink();

    final reason = _reason;
    final dl = _download;
    final String desc;
    Color descColor = AppColors.muted;
    String? actionLabel;
    String? action;
    switch (reason) {
      case 'ready':
        desc = t('voiceGuideReadyDesc');
        descColor = AppColors.accent;
      case 'downloading':
        desc = t('voiceGuideDownloading');
        actionLabel = t('airVoiceLocalCancel');
        action = 'cancel';
      case 'failed':
        desc = t('voiceGuideFailed', {
          'error': (dl['error'] ?? t('airVoiceLocalUnknownError')).toString(),
        });
        descColor = AppColors.danger;
        actionLabel = t('airVoiceLocalRetry');
        action = 'download';
      case 'unsupported':
        desc = t('voiceGuideUnsupported');
      case 'disabled':
        desc = t('voiceGuideDisabled');
      default:
        final total = (dl['totalBytes'] is num)
            ? (dl['totalBytes'] as num).round()
            : 0;
        desc = t('voiceGuideMissing', {
          'size': total > 0 ? formatBytes(total) : '229 MB',
        });
        actionLabel = t('voiceGuideDownload');
        action = 'download';
    }
    final percent = (dl['percent'] is num)
        ? (dl['percent'] as num).toDouble()
        : 0.0;

    return Container(
      key: const ValueKey('voice-setup-panel'),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: _ready ? AppColors.line : AppColors.accent),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(
                _ready ? Icons.check_circle_outline : Icons.mic_off_outlined,
                size: 18,
                color: _ready ? AppColors.accent : AppColors.blue,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _ready ? t('voiceGuideReadyTitle') : t('voiceGuideTitle'),
                  style: const TextStyle(
                    color: AppColors.textBright,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            desc,
            style: TextStyle(color: descColor, fontSize: 13, height: 1.5),
          ),
          if (reason == 'downloading') ...[
            const SizedBox(height: 10),
            LinearProgressIndicator(
              key: const ValueKey('voice-setup-progress'),
              value: (percent / 100).clamp(0.0, 1.0),
              minHeight: 6,
              borderRadius: BorderRadius.circular(3),
            ),
            const SizedBox(height: 6),
            Text(
              _progressText(),
              style: const TextStyle(color: AppColors.muted, fontSize: 11.5),
            ),
          ],
          if (_actionError != null) ...[
            const SizedBox(height: 6),
            Text(
              _actionError!,
              style: const TextStyle(color: AppColors.danger, fontSize: 12),
            ),
          ],
          if (action != null || widget.onOpenSettings != null) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (action != null)
                  action == 'cancel'
                      ? OutlinedButton(
                          key: const ValueKey('voice-setup-action'),
                          onPressed: _busy ? null : () => _act('cancel'),
                          child: Text(actionLabel!),
                        )
                      : FilledButton(
                          key: const ValueKey('voice-setup-action'),
                          onPressed: _busy ? null : () => _act('download'),
                          child: Text(actionLabel!),
                        ),
                if (widget.onOpenSettings != null && !_ready)
                  TextButton(
                    onPressed: widget.onOpenSettings,
                    child: Text(t('voiceSettings')),
                  ),
              ],
            ),
          ],
          if (!_ready) ...[
            const SizedBox(height: 8),
            Text(
              t('voiceGuideCloudOnWeb'),
              style: const TextStyle(color: AppColors.muted, fontSize: 11.5),
            ),
          ],
        ],
      ),
    );
  }
}

/// 麦克风发现语音用不了时弹出的底部面板。[readiness] 是服务端已经给出的那份
/// （没有就由面板自己去问）。
Future<void> showVoiceSetupSheet(
  BuildContext context,
  SettingsService settings, {
  Map<String, dynamic>? readiness,
}) {
  final manage = ManageService(settings: settings);
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (sheet) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 16),
        child: VoiceSetupPanel(
          manage: manage,
          initial: readiness,
          onOpenSettings: () {
            Navigator.of(sheet).pop();
            Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => VoiceSettingsScreen(settings: settings),
              ),
            );
          },
        ),
      ),
    ),
  );
}
