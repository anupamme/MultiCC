import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:multicc_app/i18n.dart';
import 'package:multicc_app/services/onboarding_store.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/screens/air_settings_screen.dart';
import 'package:multicc_app/screens/settings_screen.dart';
import 'package:multicc_app/widgets/air_tasks_view.dart';
import 'package:multicc_app/widgets/air/air_schedules.dart';
import 'package:multicc_app/widgets/lan_discovery_picker.dart';
import 'package:multicc_app/widgets/named_back_button.dart';

void main() {
  setUpAll(() => I18n.init('zh'));
  Future<SettingsService> settings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://localhost:3000',
      OnboardingStore.doneKey: '1',
    });
    return SettingsService.getInstance();
  }

  http.Client client({bool Function()? configured}) => MockClient((req) async {
    dynamic body = <String, dynamic>{};
    if (req.url.path == '/api/air') {
      body = {
        'ok': true,
        'clis': ['codex'],
        'directories': [
          {'id': 'one', 'name': '项目一', 'path': '/projects/one'},
          {'id': 'two', 'name': '项目二', 'path': '/projects/two'},
        ],
        'tasks': [
          {
            'id': 't1',
            'dirId': 'one',
            'title': '首页改版',
            'status': 'active',
            'runState': 'waiting',
          },
          {
            'id': 't2',
            'dirId': 'two',
            'title': '反馈整理',
            'status': 'done',
            'runState': 'succeeded',
          },
        ],
        'sessions': [],
      };
    } else if (req.url.path == '/api/settings/power') {
      body = {'ok': true, 'available': false};
    } else if (req.url.path == '/api/cron' ||
        req.url.path == '/api/docs-registry') {
      body = [];
    } else if (req.url.path == '/api/aux/config' && configured != null) {
      body = {
        'providerId': configured() ? 'configured' : '',
        'cliAvailability': {'claude': false, 'codex': false},
      };
    }
    return http.Response(
      jsonEncode(body),
      200,
      headers: {'content-type': 'application/json'},
    );
  });

  testWidgets('手机导航保留项目、任务、五类设置和原生服务连接入口', (tester) async {
    final config = await settings();
    final transport = client();
    var switches = 0;
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(
          settings: config,
          httpClient: transport,
          onSwitchServer: () => switches++,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(NavigationBar), findsOneWidget);
    expect(find.byKey(const ValueKey('air-mobile-create')), findsOneWidget);
    await tester.ensureVisible(find.text('项目资料'));
    await tester.tap(find.text('项目资料'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text(t('airDocs')));
    await tester.tap(find.text(t('airDocs')));
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byType(NamedBackButton),
        matching: find.text('控制台'),
      ),
      findsOneWidget,
    );
    expect(find.byType(NavigationBar), findsNothing);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(NavigationBar),
        matching: find.text('最近任务'),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('air-mobile-task-search')),
      findsOneWidget,
    );
    await tester.enterText(
      find.byKey(const ValueKey('air-mobile-task-search')),
      '不存在',
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-task-t1')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('air-mobile-settings')));
    await tester.pumpAndSettle();
    expect(find.byType(AirSettingsScreen), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    expect(
      find.descendant(
        of: find.byType(NamedBackButton),
        matching: find.text('最近任务'),
      ),
      findsOneWidget,
    );
    for (final title in ['模型与线路', '手机与通知', '电脑与电源', '数据与安全', '高级']) {
      expect(
        find.byKey(ValueKey('air-settings-category-$title')),
        findsOneWidget,
      );
    }
    await tester.tap(find.byKey(const ValueKey('air-settings-switch-server')));
    await tester.pumpAndSettle();
    expect(switches, 1);
    await tester.tap(find.byKey(const ValueKey('air-settings-connection')));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(find.byType(LanDiscoveryPicker), findsOneWidget);
    expect(find.text(t('saveAndReconnect')), findsOneWidget);
    expect(find.text('连接与服务地址'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('air-mobile-task-search')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('air-task-t1')),
      findsNothing,
      reason: '返回保留筛选状态',
    );
    await tester.tap(find.byKey(const ValueKey('air-mobile-project-picker')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-mobile-project-two')));
    await tester.pumpAndSettle();
    expect(find.text('项目二'), findsWidgets);
    await tester.enterText(
      find.byKey(const ValueKey('air-mobile-task-search')),
      '',
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-task-t2')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    transport.close();
  });

  testWidgets('手机首启保留缺配置提示，从设置返回后重查配置', (tester) async {
    final config = await settings();
    var configured = false;
    final transport = client(configured: () => configured);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: config, httpClient: transport),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-mobile-setup')), findsOneWidget);
    expect(find.textContaining('请先在电脑端安装'), findsOneWidget);
    await tester.tap(find.text('打开设置'));
    await tester.pumpAndSettle();
    expect(find.byType(AirSettingsScreen), findsOneWidget);
    configured = true;
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-mobile-setup')), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    transport.close();
  });

  testWidgets('手机三个宽度、大字号与新任务弹层不溢出', (tester) async {
    final config = await settings();
    final transport = client();
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    for (final width in [360.0, 390.0, 430.0]) {
      tester.view.physicalSize = Size(width, 844);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: const TextScaler.linear(1.3)),
            child: child!,
          ),
          home: AirTasksView(settings: config, httpClient: transport),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final rect = tester.getRect(find.byType(NavigationBar));
      expect(rect.right <= width, true);
      expect(rect.bottom <= 844, true);
    }
    await tester.tap(find.byKey(const ValueKey('air-mobile-create')));
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsOneWidget);
    expect(find.byKey(const ValueKey('air-quick-input')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(NavigationBar),
        matching: find.text('定时任务'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(AirSchedulePanel), findsOneWidget);
    tester.view.physicalSize = const Size(900, 844);
    await tester.pumpAndSettle();
    expect(
      find.byType(AirSchedulePanel),
      findsOneWidget,
      reason: '横屏跨越手机断点后仍保留当前页面',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    transport.close();
  });
}
