import 'dart:async';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import '../../services/manage_service.dart';
import '../../services/settings_service.dart';
import '../../theme.dart';

/// 手机首启提示沿用原来的配置判定和跳过记录，配置操作统一进入设置。
class AirMobileSetup extends StatefulWidget {
  const AirMobileSetup({
    super.key,
    required this.settings,
    required this.onSettings,
    this.httpClient,
  });
  final SettingsService settings;
  final http.Client? httpClient;
  final Future<void> Function() onSettings;

  @override
  State<AirMobileSetup> createState() => AirMobileSetupState();
}

class AirMobileSetupState extends State<AirMobileSetup> {
  bool _needsSetup = false, _cliMissing = false;
  late bool _dismissed = widget.settings.airSetupDismissed;

  @override
  void initState() {
    super.initState();
    unawaited(refresh());
  }

  Future<void> refresh() async {
    try {
      final config = await ManageService(
        settings: widget.settings,
        httpClient: widget.httpClient,
      ).fetchAuxConfig();
      if (!mounted || config.isEmpty) return;
      final availability = config['cliAvailability'];
      setState(() {
        _needsSetup = (config['providerId'] ?? '').toString().isEmpty;
        _cliMissing =
            availability is Map &&
            availability['claude'] == false &&
            availability['codex'] == false;
      });
    } catch (_) {
      // 配置状态未知时不把网络错误当成「尚未配置」。
    }
  }

  Future<void> _dismiss() async {
    setState(() => _dismissed = true);
    try {
      await widget.settings.dismissAirSetup();
    } catch (_) {
      // 本次已跳过，持久化失败也不反复打断用户。
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_needsSetup || _dismissed) return const SizedBox.shrink();
    return Container(
      key: const ValueKey('air-mobile-setup'),
      margin: const EdgeInsets.only(top: 18),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.blueSoft,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('完成首次配置', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          const Text('在设置的「模型与线路」中连接模型服务并配置 AI 助手。'),
          if (_cliMissing) ...[
            const SizedBox(height: 8),
            const Text('电脑上尚未安装可用的 AI 工具，请先在电脑端安装 Claude 或 Codex。'),
          ],
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: () => unawaited(widget.onSettings()),
                child: const Text('打开设置'),
              ),
              TextButton(
                onPressed: () => unawaited(_dismiss()),
                child: const Text('暂时跳过'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
