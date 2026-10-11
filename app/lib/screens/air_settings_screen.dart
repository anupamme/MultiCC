import 'dart:async';
import 'package:flutter/material.dart';
import '../i18n.dart';
import '../services/settings_service.dart';
import '../theme.dart';
import '../widgets/air/air_ops.dart';
import '../widgets/air/air_ops_store.dart';
import '../widgets/named_back_button.dart';
import 'agent_resources_screen.dart';
import 'aux_screen.dart';
import 'bridge_settings_screen.dart';
import 'events_screen.dart';
import 'provider_screen.dart';
import 'push_settings_screen.dart';
import 'secrets_screen.dart';
import 'settings_screen.dart';
import 'token_usage_screen.dart';
import 'tunnel_settings_screen.dart';
import 'voice_settings_screen.dart';

/// 设置是独立路由。连接管理复用原生发现、历史地址和保存前验证，不经过网页。
class AirSettingsScreen extends StatelessWidget {
  const AirSettingsScreen({
    super.key,
    required this.settings,
    required this.ops,
    required this.onLogout,
    required this.onOnboarding,
    this.onSwitchServer,
    this.onVoiceCall,
    this.returnLabel = '控制台',
    this.clientVersion,
  });
  final SettingsService settings;
  final AirOpsStore ops;
  final VoidCallback onLogout, onOnboarding;
  final VoidCallback? onSwitchServer, onVoiceCall;
  final String returnLabel;
  final String? clientVersion;

  Future<void> _open(BuildContext context, Widget page, String from) =>
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          settings: RouteSettings(arguments: {'backLabel': from}),
          builder: (_) => page,
        ),
      );

  Widget _row(
    String title,
    String subtitle,
    IconData icon,
    VoidCallback onTap, {
    Key? key,
  }) => ListTile(
    key: key,
    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
    leading: Container(
      padding: const EdgeInsets.all(9),
      decoration: BoxDecoration(
        color: AppColors.bg,
        borderRadius: BorderRadius.circular(11),
      ),
      child: Icon(icon, color: AppColors.accent, size: 22),
    ),
    title: Text(
      title,
      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
    ),
    subtitle: Text(
      subtitle,
      style: const TextStyle(fontSize: 12, color: AppColors.muted),
    ),
    trailing: const Icon(Icons.chevron_right, color: AppColors.faint),
    onTap: onTap,
  );

  Widget _card(List<Widget> children) => Container(
    decoration: BoxDecoration(
      color: AppColors.panel,
      border: Border.all(color: AppColors.line),
      borderRadius: BorderRadius.circular(16),
    ),
    clipBehavior: Clip.antiAlias,
    child: Column(
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) const Divider(height: 1),
          children[i],
        ],
      ],
    ),
  );

  void _category(BuildContext context, String title) {
    unawaited(
      _open(
        context,
        _SettingsCategory(
          title: title,
          buildContent: (ctx) => _categoryContent(ctx, title),
        ),
        '设置',
      ),
    );
  }

  List<Widget> _categoryContent(BuildContext context, String title) {
    Widget detail(String name, String hint, IconData icon, Widget page) =>
        _row(name, hint, icon, () => unawaited(_open(context, page, title)));
    Widget local(SettingsPanel panel, String hint, IconData icon) => detail(
      panel.title,
      hint,
      icon,
      SettingsScreen(settings: settings, panel: panel),
    );
    return [
      if (title == '模型与线路')
        _card([
          detail(
            t('auxAssistant'),
            '日常任务与辅助功能使用的助手',
            Icons.auto_awesome_outlined,
            AuxScreen(settings: settings),
          ),
          detail(
            t('providerConfig'),
            '模型服务、线路与账号',
            Icons.swap_horiz,
            ProviderScreen(settings: settings),
          ),
          detail(
            t('tokenUsage'),
            '查看使用情况与额度',
            Icons.data_usage,
            TokenUsageScreen(settings: settings),
          ),
          local(SettingsPanel.models, '新建任务的默认模型', Icons.tune),
          local(SettingsPanel.goal, '开始执行前的目标检查', Icons.fact_check_outlined),
        ]),
      if (title == '手机与通知')
        _card([
          local(
            SettingsPanel.connection,
            '发现本地服务、历史地址、手动连接',
            Icons.dns_outlined,
          ),
          local(
            SettingsPanel.notifications,
            '本机任务提醒与后台运行',
            Icons.notifications_outlined,
          ),
          detail(
            t('pushNotifications'),
            '推送渠道与提醒设置',
            Icons.notifications_active_outlined,
            PushSettingsScreen(settings: settings),
          ),
          detail(
            t('tunnel'),
            '从外网访问电脑上的服务',
            Icons.public,
            TunnelSettingsScreen(settings: settings),
          ),
          detail(
            t('voiceSettings'),
            '语音输入、朗读与通话配置',
            Icons.mic_none,
            VoiceSettingsScreen(settings: settings),
          ),
          if (onVoiceCall != null)
            _row('语音通话', '与助手直接说话', Icons.call_outlined, onVoiceCall!),
          detail(
            t('messageBridges'),
            '外部消息工具与通知桥接',
            Icons.hub_outlined,
            BridgeSettingsScreen(settings: settings),
          ),
        ]),
      if (title == '电脑与电源')
        ListenableBuilder(
          listenable: ops,
          builder: (context, _) => _card([
            if (ops.lidSleepAvailable == true)
              SwitchListTile(
                title: const Text('关盖运行'),
                subtitle: const Text('控制服务所在电脑的休眠行为'),
                value: ops.lidSleepOn,
                onChanged: (_) => unawaited(ops.toggleLidSleep()),
              ),
            if (ops.autoUnlockAvailable)
              SwitchListTile(
                title: const Text('允许自动解锁'),
                value: ops.autoUnlockOn,
                onChanged: (_) => unawaited(ops.toggleAutoUnlock()),
              ),
            AirOpsPanel(
              store: ops,
              onOpenPush: () => unawaited(
                _open(context, PushSettingsScreen(settings: settings), title),
              ),
              onLogout: onLogout,
            ),
            AirOpsReceipt(store: ops),
          ]),
        ),
      if (title == '数据与安全')
        _card([
          detail(
            t('secretsVaultEntry'),
            t('secretsVaultHint'),
            Icons.key_outlined,
            SecretsScreen(settings: settings),
          ),
          detail(
            '数据与存储',
            '存储用量、备份与清理',
            Icons.storage_outlined,
            AgentResourcesScreen(
              settings: settings,
              initialSection: AgentResourcesInitialSection.storage,
            ),
          ),
          local(SettingsPanel.security, '服务访问密码与权限', Icons.shield_outlined),
        ]),
      if (title == '高级') ...[
        _card([
          local(SettingsPanel.advanced, '基础模式与开发者模式', Icons.code),
          local(SettingsPanel.appearance, '语言、字号与显示', Icons.text_fields),
          detail(
            t('agentResources'),
            t('agentResourcesHint'),
            Icons.dataset_outlined,
            AgentResourcesScreen(settings: settings),
          ),
          detail(
            '技能同步',
            '管理服务端的技能同步',
            Icons.sync,
            AgentResourcesScreen(
              settings: settings,
              initialSection: AgentResourcesInitialSection.skillSync,
            ),
          ),
          detail(
            t('activityLog'),
            t('activityLogHint'),
            Icons.history,
            EventsScreen(settings: settings),
          ),
          local(SettingsPanel.about, 'App 版本与更新', Icons.info_outline),
          _row(
            t('onboarding'),
            '重新打开工作区上手引导',
            Icons.help_outline,
            onOnboarding,
          ),
        ]),
        const SizedBox(height: 18),
        AirVersionRow(
          store: ops,
          clientVersion: clientVersion,
          language: settings.lang,
          onLanguage: () => unawaited(
            settings.setLanguage(settings.lang == 'zh' ? 'en' : 'zh'),
          ),
        ),
      ],
    ];
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AppColors.bg,
    appBar: AppBar(
      leading: NamedBackButton(label: returnLabel),
      leadingWidth: 110,
      title: const Text('设置'),
    ),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('所有配置，在这里找到。', style: TextStyle(color: AppColors.muted)),
        const SizedBox(height: 18),
        _card([
          _row(
            '连接与服务地址',
            settings.host.isEmpty ? '尚未连接' : settings.host,
            Icons.computer_outlined,
            () => unawaited(
              _open(
                context,
                SettingsScreen(
                  settings: settings,
                  panel: SettingsPanel.connection,
                ),
                '设置',
              ),
            ),
            key: const ValueKey('air-settings-connection'),
          ),
          if (onSwitchServer != null)
            _row(
              '切换服务',
              '选择历史地址或连接另一台电脑',
              Icons.swap_horiz,
              onSwitchServer!,
              key: const ValueKey('air-settings-switch-server'),
            ),
        ]),
        const SizedBox(height: 20),
        _card([
          for (final item in <(String, String, IconData)>[
            ('模型与线路', '助手、模型服务、用量', Icons.auto_awesome_outlined),
            ('手机与通知', '连接、通知、后台运行与语音', Icons.phone_iphone),
            ('电脑与电源', '电脑状态、休眠与主机维护', Icons.computer_outlined),
            ('数据与安全', '敏感信息、存储与访问权限', Icons.shield_outlined),
            ('高级', '开发者模式、语言与更新', Icons.tune),
          ])
            _row(
              item.$1,
              item.$2,
              item.$3,
              () => _category(context, item.$1),
              key: ValueKey('air-settings-category-${item.$1}'),
            ),
        ]),
      ],
    ),
  );
}

class _SettingsCategory extends StatelessWidget {
  const _SettingsCategory({required this.title, required this.buildContent});
  final String title;
  final List<Widget> Function(BuildContext) buildContent;
  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: AppColors.bg,
    appBar: AppBar(
      leading: const NamedBackButton(),
      leadingWidth: 100,
      title: Text(title),
    ),
    body: ListView(
      padding: const EdgeInsets.all(16),
      children: buildContent(context),
    ),
  );
}
