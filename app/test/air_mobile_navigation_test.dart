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
    // 原「最近任务」页并进了控制台：搜索框就在控制台下段清单的头上。
    expect(
      find.byKey(const ValueKey('air-mobile-task-search')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('air-task-t2')), findsOneWidget);
    await tester.enterText(
      find.byKey(const ValueKey('air-mobile-task-search')),
      '不存在',
    );
    await tester.pumpAndSettle();
    // t1 还在上段「等我处理」里（那一段不吃搜索），所以看只在清单里的 t2。
    expect(find.byKey(const ValueKey('air-task-t2')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('air-mobile-settings')));
    await tester.pumpAndSettle();
    expect(find.byType(AirSettingsScreen), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    expect(
      find.descendant(
        of: find.byType(NamedBackButton),
        matching: find.text('控制台'),
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
      find.byKey(const ValueKey('air-task-t2')),
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

  testWidgets('手机控制台按状态格筛选，今日完成只列今天跑完的', (tester) async {
    final config = await settings();
    final now = DateTime.now().millisecondsSinceEpoch;
    final transport = MockClient((req) async {
      dynamic body = <String, dynamic>{};
      if (req.url.path == '/api/air') {
        body = {
          'ok': true,
          'clis': ['codex'],
          'directories': [
            {'id': 'one', 'name': '项目一', 'path': '/projects/one'},
          ],
          'tasks': [
            {
              'id': 'w',
              'dirId': 'one',
              'title': '等我回答的',
              'status': 'active',
              'runState': 'waiting',
              'updatedAt': now,
            },
            {
              'id': 'd1',
              'dirId': 'one',
              'title': '今天做完的',
              'status': 'active',
              'runState': 'succeeded',
              'updatedAt': now - 1000,
            },
            {
              'id': 'd2',
              'dirId': 'one',
              'title': '昨天做完的',
              'status': 'active',
              'runState': 'succeeded',
              'updatedAt': now - 2 * 86400000,
            },
          ],
          'sessions': [],
        };
      } else if (req.url.path == '/api/settings/power') {
        body = {'ok': true, 'available': false};
      } else if (req.url.path == '/api/cron' ||
          req.url.path == '/api/docs-registry') {
        body = [];
      }
      return http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
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
    // 默认那一格是「最近任务」：三条都在清单里。
    expect(find.text('今天做完的'), findsOneWidget);
    expect(find.text('昨天做完的'), findsOneWidget);
    final today = find.byKey(const ValueKey('air-mobile-filter-today'));
    await tester.ensureVisible(today);
    expect(
      find.descendant(of: today, matching: find.text('今日完成 1')),
      findsOneWidget,
    );
    await tester.tap(today);
    await tester.pumpAndSettle();
    expect(tester.widget<ChoiceChip>(today).selected, isTrue);
    expect(find.text('今天做完的'), findsOneWidget);
    expect(find.text('昨天做完的'), findsNothing);
    // 控制台里不再有「全部 ›」跳最近任务页那颗按钮。
    expect(find.byKey(const ValueKey('air-mobile-console-all')), findsNothing);
  });

  testWidgets('移动工作区「等我处理」卡与控制台同口径：含手动待办、排除忽略、最早消息在前', (tester) async {
    final config = await settings();
    final now = DateTime.now().millisecondsSinceEpoch;
    final transport = MockClient((req) async {
      dynamic body = <String, dynamic>{};
      if (req.url.path == '/api/air') {
        body = {
          'ok': true,
          'clis': ['codex'],
          'directories': [
            {'id': 'one', 'name': '项目一', 'path': '/projects/one'},
          ],
          // 服务端下发的两份清单，客户端只按它们回填（与目录 / 控制台同源）。
          'taskTodos': ['manual'],
          'taskTodoIgnored': ['ignored'],
          'tasks': [
            {
              'id': 'ignored',
              'dirId': 'one',
              'title': '被忽略的',
              'status': 'active',
              'runState': 'error',
              'updatedAt': now - 500,
              'lastMessageAt': now - 500,
            },
            {
              'id': 'new',
              'dirId': 'one',
              'title': '较新的待办',
              'status': 'active',
              'runState': 'waiting',
              'updatedAt': now - 1000,
              'lastMessageAt': now - 1000,
            },
            {
              'id': 'manual',
              'dirId': 'one',
              'title': '手动待办',
              'status': 'active',
              'runState': 'idle',
              'updatedAt': now - 8000,
              'lastMessageAt': now - 8000,
            },
            {
              'id': 'old',
              'dirId': 'one',
              'title': '最早的待办',
              'status': 'active',
              'runState': 'error',
              'updatedAt': now - 9000,
              'lastMessageAt': now - 9000,
            },
            {
              'id': 'newest',
              'dirId': 'one',
              'title': '最新的待办',
              'status': 'active',
              'runState': 'waiting',
              'updatedAt': now - 200,
              'lastMessageAt': now - 200,
            },
          ],
          'sessions': [],
        };
      } else if (req.url.path == '/api/settings/power') {
        body = {'ok': true, 'available': false};
      } else if (req.url.path == '/api/cron' ||
          req.url.path == '/api/docs-registry') {
        body = [];
      }
      return http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
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

    final card = find.byKey(const ValueKey('air-mobile-todo-card'));
    expect(card, findsOneWidget);
    // 卡片标题与控制台 / 整页同一个词（airNeedsMeFilter）。
    expect(
      find.descendant(of: card, matching: find.text('等我处理')),
      findsOneWidget,
    );
    // 手动待办（空闲着但被标记）在卡里。
    expect(
      find.descendant(of: card, matching: find.text('手动待办')),
      findsOneWidget,
    );
    // 被忽略的异常不在卡里：忽略压过运行态。
    expect(
      find.descendant(of: card, matching: find.text('被忽略的')),
      findsNothing,
    );
    // 最早的消息在前：old（9000ms 前）→ manual（8000ms 前）→ new（1000ms 前）。
    final yOld = tester
        .getTopLeft(find.descendant(of: card, matching: find.text('最早的待办')))
        .dy;
    final yManual = tester
        .getTopLeft(find.descendant(of: card, matching: find.text('手动待办')))
        .dy;
    final yNew = tester
        .getTopLeft(find.descendant(of: card, matching: find.text('较新的待办')))
        .dy;
    expect(yOld, lessThan(yManual), reason: '等得最久的排最前');
    expect(yManual, lessThan(yNew), reason: '手动待办也按最早消息参与排序');

    // 卡片只摆等最久的三条，第四条藏在「全部记录 · 4」后面。
    expect(
      find.descendant(of: card, matching: find.text('最新的待办')),
      findsNothing,
    );
    final all = find.byKey(const ValueKey('air-mobile-todo-all'));
    expect(
      find.descendant(of: card, matching: find.text('全部记录 · 4')),
      findsOneWidget,
    );
    await tester.ensureVisible(all);
    await tester.tap(all);
    await tester.pumpAndSettle();
    // 点「全部」把下段清单切到「等我处理」这一格（不再跳页）：四条都在，被忽略
    // 的仍然不在。
    expect(
      find.byKey(const ValueKey('air-mobile-task-search')),
      findsOneWidget,
    );
    expect(find.text('最新的待办'), findsOneWidget);
    expect(find.text('被忽略的'), findsNothing);
    final needs = find.byKey(const ValueKey('air-mobile-filter-needsMe'));
    expect(
      tester.widget<ChoiceChip>(needs).selected,
      isTrue,
      reason: '卡片「全部」切过去的是「等我处理」这一格',
    );
    expect(
      find.descendant(of: needs, matching: find.text('等我处理 4')),
      findsOneWidget,
    );
    // 「待办」仍在筛选项里，但只收手动标记，和汇总不是一回事。
    final todo = find.byKey(const ValueKey('air-mobile-filter-todo'));
    expect(
      find.descendant(of: todo, matching: find.text('待办 1')),
      findsOneWidget,
    );
    expect(tester.widget<ChoiceChip>(todo).selected, isFalse);
  });

  testWidgets('手机控制台顶栏按项目筛选清单，选完留在控制台', (tester) async {
    final config = await settings();
    final now = DateTime.now().millisecondsSinceEpoch;
    final transport = MockClient((req) async {
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
              'id': 'a',
              'dirId': 'one',
              'title': '项目一的活',
              'status': 'active',
              'runState': 'idle',
              'updatedAt': now,
            },
            {
              'id': 'b',
              'dirId': 'two',
              'title': '项目二的活',
              'status': 'active',
              'runState': 'idle',
              'updatedAt': now - 1000,
            },
          ],
          'sessions': [],
        };
      } else if (req.url.path == '/api/settings/power') {
        body = {'ok': true, 'available': false};
      } else if (req.url.path == '/api/cron' ||
          req.url.path == '/api/docs-registry') {
        body = [];
      }
      return http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
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
    // 控制台：默认「全部项目」，两个项目的任务都在。
    final picker = find.byKey(const ValueKey('air-mobile-project-picker'));
    expect(
      find.descendant(of: picker, matching: find.text('全部项目')),
      findsOneWidget,
    );
    expect(find.text('项目一的活'), findsOneWidget);
    expect(find.text('项目二的活'), findsOneWidget);
    await tester.tap(picker);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-mobile-project-two')));
    await tester.pumpAndSettle();
    // 仍在控制台，只剩项目二的任务。
    expect(
      tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      0,
    );
    expect(
      find.byKey(const ValueKey('air-mobile-task-search')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: picker, matching: find.text('项目二')),
      findsOneWidget,
    );
    expect(find.text('项目一的活'), findsNothing);
    expect(find.text('项目二的活'), findsOneWidget);
    // 选回全部项目。
    await tester.tap(picker);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('air-mobile-project-all')));
    await tester.pumpAndSettle();
    expect(find.text('项目一的活'), findsOneWidget);
    expect(find.text('项目二的活'), findsOneWidget);
  });

  testWidgets('底部导航三项：控制台 / 定时任务 / 工作目录，目录首页归第 3 项高亮', (tester) async {
    final config = await settings();
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: AirTasksView(settings: config, httpClient: client()),
      ),
    );
    await tester.pumpAndSettle();
    // 「最近任务」已并进控制台，底部只剩三项。
    final nav = find.byType(NavigationBar);
    expect(
      find.descendant(of: nav, matching: find.byType(NavigationDestination)),
      findsNWidgets(3),
    );
    for (final label in ['控制台', '定时任务', '工作目录']) {
      expect(
        find.descendant(of: nav, matching: find.text(label)),
        findsOneWidget,
      );
    }
    expect(find.descendant(of: nav, matching: find.text('最近任务')), findsNothing);
    expect(tester.widget<NavigationBar>(nav).selectedIndex, 0);
    await tester.tap(find.descendant(of: nav, matching: find.text('定时任务')));
    await tester.pumpAndSettle();
    expect(tester.widget<NavigationBar>(nav).selectedIndex, 1);
    // 第 3 项「工作目录」→ 目录库视图，目录卡可见。
    await tester.tap(
      find.descendant(
        of: find.byType(NavigationBar),
        matching: find.text('工作目录'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-directory-one')), findsOneWidget);
    expect(tester.widget<NavigationBar>(nav).selectedIndex, 2);
    // 点目录卡进目录首页：NavigationBar 的选中项仍是「工作目录」（index 2）。
    await tester.tap(find.byKey(const ValueKey('air-directory-one')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('air-directory-mode')), findsOneWidget);
    expect(
      tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      2,
    );
  });

  testWidgets('手机首页长按任务行就能标记 / 取消待办，不必先进目录', (tester) async {
    final config = await settings();
    final todos = <String>[];
    final toggles = <Object?>[];
    final transport = MockClient((req) async {
      dynamic body = <String, dynamic>{};
      if (req.url.path == '/api/air/todos/toggle') {
        final id = (jsonDecode(req.body) as Map)['taskId'] as String;
        toggles.add(id);
        todos.contains(id) ? todos.remove(id) : todos.add(id);
        body = {'ok': true, 'taskIds': todos};
      } else if (req.url.path == '/api/air') {
        body = {
          'ok': true,
          'clis': ['codex'],
          'directories': [
            {'id': 'one', 'name': '项目一', 'path': '/projects/one'},
          ],
          'taskTodos': todos,
          'tasks': [
            {
              'id': 't1',
              'dirId': 'one',
              'title': '首页改版',
              'status': 'active',
              'runState': 'idle',
            },
          ],
          'sessions': [],
        };
      } else if (req.url.path == '/api/settings/power') {
        body = {'ok': true, 'available': false};
      } else if (req.url.path == '/api/cron' ||
          req.url.path == '/api/docs-registry') {
        body = [];
      }
      return http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
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
    // 标记之后这条任务会同时出现在「等我处理」卡和最近列表里，所以取第一行来点、
    // 标记按钮也按「至少一处」断言 —— 两处本来就是同一份数据。
    final row = find.byKey(const ValueKey('air-task-t1')).first;
    final flag = find.byKey(const ValueKey('air-task-todo-mark-t1'));
    await tester.ensureVisible(row);
    expect(flag, findsNothing);

    await tester.longPress(row);
    await tester.pumpAndSettle();
    expect(toggles, ['t1']);
    expect(find.text('已标记为待办「首页改版」'), findsOneWidget);
    expect(flag, findsWidgets);

    await tester.longPress(row);
    await tester.pumpAndSettle();
    expect(toggles, ['t1', 't1']);
    expect(find.text('已取消待办「首页改版」'), findsOneWidget);
    expect(flag, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('控制台下段清单不截断：45 条任务滚到底都在（旧服务本地快照）', (tester) async {
    final config = await settings();
    final now = DateTime.now().millisecondsSinceEpoch;
    final transport = MockClient((req) async {
      dynamic body = <String, dynamic>{};
      if (req.url.path == '/api/air') {
        body = {
          'ok': true,
          'clis': ['codex'],
          'directories': [
            {'id': 'one', 'name': '项目一', 'path': '/projects/one'},
          ],
          'tasks': [
            for (var i = 0; i < 45; i++)
              {
                'id': 'n$i',
                'dirId': 'one',
                'title': '第 $i 条',
                'status': 'active',
                'runState': 'idle',
                'updatedAt': now - i * 1000,
              },
          ],
          'sessions': [],
        };
      } else if (req.url.path == '/api/settings/power') {
        body = {'ok': true, 'available': false};
      } else if (req.url.path == '/api/cron' ||
          req.url.path == '/api/docs-registry') {
        body = [];
      }
      return http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
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
    final recent = find.byKey(const ValueKey('air-mobile-filter-recent'));
    expect(
      find.descendant(of: recent, matching: find.text('最近任务 45')),
      findsOneWidget,
    );
    // 原来控制台卡片只摆 3 条，看全量得跳「最近任务」页；合并后的清单一条不少。
    final last = find.byKey(const ValueKey('air-task-n44'));
    await tester.scrollUntilVisible(
      last,
      400,
      scrollable: find
          .descendant(
            of: find.byKey(const PageStorageKey('mobile-console-scroll')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(last, findsOneWidget);
    expect(find.byKey(const ValueKey('air-mobile-list-more')), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
