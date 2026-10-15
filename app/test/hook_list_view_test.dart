import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/event_trigger_service.dart';
import 'package:multicc_app/services/settings_service.dart';
import 'package:multicc_app/widgets/hook_list_view.dart';

// 「触发器任务」tab：列表渲染、启停、新建/编辑弹层的请求体与校验。
// 会话列表（作用范围下拉）走 SessionService 的真 http，测试里取不到时编辑器按设计
// 退化为只建全局规则，所以这里只测全局路径。

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late List<http.Request> calls;
  late List<Map<String, dynamic>> items;

  http.Response ok(Object body) => http.Response(
    jsonEncode(body),
    200,
    headers: {'content-type': 'application/json'},
  );

  Future<EventTriggerService> service() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    final settings = await SettingsService.getInstance();
    return EventTriggerService(
      settings: settings,
      httpClient: MockClient((request) async {
        calls.add(request);
        if (request.method == 'GET') return ok({'items': items});
        return ok({'ok': true});
      }),
    );
  }

  setUp(() {
    calls = [];
    items = [
      {
        'scope': 'global',
        'sessionId': null,
        'rule': {
          'id': 'g1',
          'name': '',
          'enabled': true,
          'on': ['task.done'],
          'filter': {},
          'action': {'kind': 'inject-prompt', 'prompt': '继续部署'},
        },
        'lastRun': null,
      },
      {
        'scope': 'session',
        'sessionId': 's1',
        'sessionLabel': 'My chat',
        'rule': {
          'id': 'x1',
          'name': '失败告警',
          'enabled': false,
          'on': ['task.failed'],
          'filter': {},
          'action': {'kind': 'notify'},
        },
        'lastRun': {'ts': 1700000000000, 'ok': false, 'error': 'boom'},
      },
    ];
  });

  // 表单比一屏长（事件清单 10 项）；弹层里靠滚动触达，所以点之前要先滚进视野。
  Future<void> tapVisible(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pumpAndSettle();
    await tester.tap(finder);
    await tester.pumpAndSettle();
  }

  Future<GlobalKey<HookListViewState>> pump(WidgetTester tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final svc = await service();
    final key = GlobalKey<HookListViewState>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: HookListView(key: key, settings: svc.settings, service: svc),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return key;
  }

  testWidgets('renders global and session rules with owner and last run', (
    tester,
  ) async {
    await pump(tester);
    expect(find.text('完成（达成目标或需要交互）'), findsOneWidget, reason: '无名称时用事件名当标题');
    expect(find.text('失败告警'), findsOneWidget);
    expect(find.textContaining('→  给会话注入指令'), findsOneWidget);
    expect(find.text('继续部署'), findsOneWidget);
    expect(find.textContaining('全局 · 尚未触发'), findsOneWidget);
    expect(find.textContaining('会话：My chat'), findsOneWidget);
    expect(find.textContaining('失败 boom'), findsOneWidget);
  });

  testWidgets('empty state explains how to create one', (tester) async {
    items = [];
    await pump(tester);
    expect(find.text('还没有触发器'), findsOneWidget);
  });

  testWidgets('toggle PUTs enabled to the owner route then reloads', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(find.byType(Switch).last); // 会话规则，当前停用 → 启用
    await tester.pumpAndSettle();
    final put = calls.firstWhere((c) => c.method == 'PUT');
    expect(put.url.path, '/api/sessions/s1/triggers/x1');
    expect(jsonDecode(put.body), {'enabled': true});
    expect(
      calls.where((c) => c.method == 'GET').length,
      2,
      reason: '写完要重新拉一次列表',
    );
  });

  testWidgets('delete asks first, then DELETEs', (tester) async {
    await pump(tester);
    await tester.tap(find.byTooltip('删除').first);
    await tester.pumpAndSettle();
    expect(find.text('删除这条触发器？'), findsOneWidget);
    expect(calls.any((c) => c.method == 'DELETE'), isFalse, reason: '确认前不删');
    await tester.tap(find.text('删除').last);
    await tester.pumpAndSettle();
    final del = calls.firstWhere((c) => c.method == 'DELETE');
    expect(del.url.path, '/api/event-rules/g1');
  });

  testWidgets('new rule: validation first, then POST body', (tester) async {
    final key = await pump(tester);
    key.currentState!.openEditor();
    await tester.pumpAndSettle();
    expect(find.text('新建触发器'), findsOneWidget);

    await tapVisible(tester, find.text('保存'));
    expect(find.text('请至少选择一个事件'), findsOneWidget);
    expect(calls.any((c) => c.method == 'POST'), isFalse);

    await tapVisible(tester, find.text('出错或被中止'));
    await tapVisible(tester, find.text('保存'));
    final post = calls.firstWhere((c) => c.method == 'POST');
    expect(post.url.path, '/api/event-rules', reason: '默认作用范围=全局');
    final body = jsonDecode(post.body) as Map<String, dynamic>;
    expect(body['on'], ['task.failed']);
    expect(body['action'], {'kind': 'notify', 'message': ''});
    expect(body['enabled'], true);
    expect(find.text('新建触发器'), findsNothing, reason: '保存成功后弹层关闭');
  });

  testWidgets('edit keeps the owner route and existing values', (tester) async {
    final key = await pump(tester);
    final svc = key.currentState!;
    final item = HookItem.fromJson(items[1]);
    svc.openEditor(item: item);
    await tester.pumpAndSettle();
    expect(find.text('编辑触发器'), findsOneWidget);
    expect(find.text('作用范围'), findsNothing, reason: '编辑不改归属');
    await tapVisible(tester, find.text('保存'));
    final put = calls.firstWhere((c) => c.method == 'PUT');
    expect(put.url.path, '/api/sessions/s1/triggers/x1');
    final body = jsonDecode(put.body) as Map<String, dynamic>;
    expect(body['name'], '失败告警');
    expect(body['on'], ['task.failed']);
    expect(body['enabled'], false);
  });

  Future<void> openSheet(
    WidgetTester tester, {
    HookItem? item,
    required EventTriggerService svc,
  }) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: HookEditor(
            service: svc,
            item: item,
            sessions: const [(id: 's2', label: '测试会话')],
            dirs: const [(id: 'd2', label: '营销仓')],
            clis: const ['claude', 'codex'],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> pick(WidgetTester tester, String current, String option) async {
    await tapVisible(tester, find.text(current));
    await tester.tap(find.text(option).last);
    await tester.pumpAndSettle();
  }

  testWidgets(
    'inject target: new session reveals workspace/CLI/title and posts newSession',
    (tester) async {
      final svc = await service();
      await openSheet(tester, svc: svc);
      await tapVisible(tester, find.text('出错或被中止'));
      await pick(tester, '通知我', '给会话注入指令');
      expect(find.text('新会话所在工作区'), findsNothing, reason: '默认注入到触发事件的会话');

      await pick(tester, '触发事件的会话', '新建会话（每次触发新建一个）');
      expect(find.text('新会话所在工作区'), findsOneWidget);
      expect(find.text('新会话使用的 CLI'), findsOneWidget);
      await pick(tester, '触发事件所在的工作区', '营销仓');
      await pick(tester, '与触发事件的会话相同', 'codex');
        await tapVisible(tester, find.text('保存'));

      final post = calls.firstWhere((c) => c.method == 'POST');
      expect(post.url.path, '/api/event-rules');
      final action =
          (jsonDecode(post.body) as Map<String, dynamic>)['action'] as Map;
      expect(action['kind'], 'inject-prompt');
      expect(action['newSession'], {
        'dirId': 'd2',
        'cli': 'codex',
        'title': '',
      });
      expect(action.containsKey('targetSessionId'), isFalse);
    },
  );

  testWidgets('inject target: a specific session posts targetSessionId', (
    tester,
  ) async {
    final svc = await service();
    await openSheet(tester, svc: svc);
    await tapVisible(tester, find.text('出错或被中止'));
    await pick(tester, '通知我', '给会话注入指令');
    await pick(tester, '触发事件的会话', '测试会话');
    expect(find.text('新会话所在工作区'), findsNothing);
    await tapVisible(tester, find.text('保存'));
    final post = calls.firstWhere((c) => c.method == 'POST');
    final action =
        (jsonDecode(post.body) as Map<String, dynamic>)['action'] as Map;
    expect(action['targetSessionId'], 's2');
    expect(action.containsKey('newSession'), isFalse);
  });

  testWidgets(
    'editing a new-session rule keeps its settings and shows the target on the card',
    (tester) async {
      final svc = await service();
      final item = HookItem.fromJson({
        'scope': 'global',
        'sessionId': null,
        'rule': {
          'id': 'g9',
          'name': '汇总',
          'enabled': true,
          'on': ['task.done'],
          'filter': {},
          'action': {
            'kind': 'inject-prompt',
            'prompt': '整理',
            'newSession': {'dirId': 'd2', 'cli': 'codex', 'title': '发布说明'},
          },
        },
        'lastRun': null,
      });
      await openSheet(tester, item: item, svc: svc);
      expect(find.text('新建会话（每次触发新建一个）'), findsOneWidget);
      expect(find.text('营销仓'), findsOneWidget);
      expect(find.text('codex'), findsOneWidget);
      expect(find.text('发布说明'), findsOneWidget);
      await tapVisible(tester, find.text('保存'));
      final put = calls.firstWhere((c) => c.method == 'PUT');
      expect(put.url.path, '/api/event-rules/g9');
      final action =
          (jsonDecode(put.body) as Map<String, dynamic>)['action'] as Map;
      expect(action['newSession'], {
        'dirId': 'd2',
        'cli': 'codex',
        'title': '发布说明',
      });
    },
  );

  testWidgets('list card says where the instruction goes', (tester) async {
    items.addAll([
      {
        'scope': 'global',
        'sessionId': null,
        'rule': {
          'id': 'n1',
          'enabled': true,
          'on': ['task.done'],
          'filter': {},
          'action': {
            'kind': 'inject-prompt',
            'prompt': 'a',
            'newSession': {'dirId': '', 'cli': '', 'title': ''},
          },
        },
        'lastRun': null,
      },
      {
        'scope': 'global',
        'sessionId': null,
        'rule': {
          'id': 'n2',
          'enabled': true,
          'on': ['task.done'],
          'filter': {},
          'action': {
            'kind': 'inject-prompt',
            'prompt': 'b',
            'targetSessionId': 's7',
          },
        },
        'lastRun': null,
      },
    ]);
    await pump(tester);
    expect(find.text('注入到：新建会话'), findsOneWidget);
    expect(find.text('注入到：会话 s7'), findsOneWidget);
    expect(find.text('注入到：触发事件的会话'), findsOneWidget, reason: '最初那条没指定目标');
  });
}
