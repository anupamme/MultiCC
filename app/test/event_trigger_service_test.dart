import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:multicc_app/services/air_service.dart';
import 'package:multicc_app/services/event_trigger_service.dart';
import 'package:multicc_app/services/settings_service.dart';

// 触发器 wire contract — 镜像 src/events/routes.js 与 public/hook-editor.js：
// GET /api/event-triggers；POST /api/event-rules | /api/sessions/:id/triggers；
// PUT/DELETE 同路径 /:ruleId；POST /api/events/test。

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<SettingsService> mockSettings() async {
    SharedPreferences.setMockInitialValues({
      'multicc_host': 'http://server.example',
      'multicc_token': 'secret',
    });
    return SettingsService.getInstance();
  }

  http.Response ok(Object body) => http.Response(
    jsonEncode(body),
    200,
    headers: {'content-type': 'application/json'},
  );

  HookItem item({String? sessionId, List<String> on = const ['task.failed']}) =>
      HookItem(
        scope: sessionId == null ? 'global' : 'session',
        sessionId: sessionId,
        rule: HookRule(
          id: 'r1',
          name: '',
          enabled: true,
          on: on,
          filter: const {},
          action: const {'kind': 'notify'},
        ),
      );

  test('fetchAll parses global + session rules with last run', () async {
    final svc = EventTriggerService(
      settings: await mockSettings(),
      httpClient: MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/api/event-triggers');
        expect(request.headers['X-Access-Token'], 'secret');
        return ok({
          'items': [
            {
              'scope': 'global',
              'sessionId': null,
              'rule': {
                'id': 'g1',
                'enabled': true,
                'on': ['task.done'],
                'filter': {},
                'action': {'kind': 'webhook', 'url': 'https://a.io/x'},
              },
              'lastRun': null,
            },
            {
              'scope': 'session',
              'sessionId': 's1',
              'sessionLabel': 'My chat',
              'rule': {
                'id': 'x1',
                'name': 'n',
                'enabled': false,
                'on': ['task.failed'],
                'filter': {'cancelled': false},
                'action': {'kind': 'notify'},
                'cooldownMs': 5000,
              },
              'lastRun': {'ts': 1700000000000, 'ok': false, 'error': 'boom'},
            },
          ],
        });
      }),
    );
    final items = await svc.fetchAll();
    expect(items, hasLength(2));
    expect(items[0].isGlobal, isTrue);
    expect(items[0].rule.kind, 'webhook');
    expect(items[0].lastRun, isNull);
    expect(items[1].sessionLabel, 'My chat');
    expect(items[1].rule.enabled, isFalse);
    expect(items[1].rule.skipCancelled, isTrue);
    expect(items[1].rule.cooldownMs, 5000);
    expect(items[1].lastRun!.ok, isFalse);
    expect(items[1].lastRun!.error, 'boom');
  });

  test(
    'create posts to the global or session route with the draft body',
    () async {
      final calls = <http.Request>[];
      final svc = EventTriggerService(
        settings: await mockSettings(),
        httpClient: MockClient((request) async {
          calls.add(request);
          return ok({'ok': true});
        }),
      );
      const draft = HookDraft(
        name: ' hi ',
        on: ['task.done'],
        skipCancelled: true,
        kind: 'webhook',
        url: ' https://a.io/h ',
        secretName: 'SIGN',
        includeConclusion: true,
        cooldownSeconds: 30,
      );
      await svc.create(draft);
      await svc.create(draft, sessionId: 'a b');
      expect(calls[0].method, 'POST');
      expect(calls[0].url.path, '/api/event-rules');
      expect(calls[1].url.path, '/api/sessions/a%20b/triggers');
      final body = jsonDecode(calls[0].body) as Map<String, dynamic>;
      expect(body, {
        'type': 'event',
        'name': 'hi',
        'on': ['task.done'],
        'filter': {'cancelled': false},
        'action': {
          'kind': 'webhook',
          'url': 'https://a.io/h',
          'secretName': 'SIGN',
          'includeConclusion': true,
        },
        'then': [],
        'enabled': true,
        'cooldownMs': 30000,
      });
    },
  );

  test('draft body per kind: notify message, inject prompt + target', () {
    expect(
      const HookDraft(
        on: ['task.failed'],
        kind: 'notify',
        message: ' m ',
      ).toJson()['action'],
      {'kind': 'notify', 'message': 'm'},
    );
    expect(
      const HookDraft(
        on: ['task.achieved'],
        kind: 'inject-prompt',
        prompt: ' 继续部署 ',
        targetSessionId: 's2',
      ).toJson()['action'],
      {'kind': 'inject-prompt', 'prompt': '继续部署', 'targetSessionId': 's2'},
    );
    // 留空目标 = 注入到触发事件的会话（不带 targetSessionId）。
    expect(
      const HookDraft(
        on: ['task.achieved'],
        kind: 'inject-prompt',
        prompt: 'p',
      ).toJson()['action'],
      {'kind': 'inject-prompt', 'prompt': 'p'},
    );
  });

  test('editing keeps unrelated filter keys and only toggles cancelled', () {
    final keep = const HookDraft(
      on: ['task.achieved'],
      kind: 'notify',
      baseFilter: {'goalState': 'achieved', 'cancelled': false},
    ).toJson()['filter'];
    expect(keep, {'goalState': 'achieved'}, reason: '取消勾选要移除 cancelled');
    final set = const HookDraft(
      on: ['task.achieved'],
      kind: 'notify',
      skipCancelled: true,
      baseFilter: {'goalState': 'achieved'},
    ).toJson()['filter'];
    expect(set, {'goalState': 'achieved', 'cancelled': false});
  });

  test('chain: then round-trips, blank editable steps are rejected', () {
    final rule = HookRule.fromJson({
      'id': 'c1',
      'on': ['task.finished'],
      'action': {'kind': 'inject-prompt', 'prompt': 'a'},
      'then': [
        {'kind': 'inject-prompt', 'prompt': 'b'},
        {'kind': 'notify', 'message': 'done'},
      ],
    });
    expect(rule.then.length, 2);
    expect(hookChainStepEditable(rule.then[0]), isTrue);
    expect(hookChainStepEditable(rule.then[1]), isFalse);
    expect(
      hookChainStepEditable({
        'kind': 'inject-prompt',
        'prompt': 'x',
        'targetSessionId': 's2',
      }),
      isFalse,
      reason: '指定目标的步骤表单编辑不了，原样保留',
    );
    expect(HookRule.fromJson({'id': 'n'}).then, isEmpty);
    final draft = HookDraft(
      on: const ['task.finished'],
      kind: 'notify',
      then: rule.then,
    );
    expect(draft.toJson()['then'], rule.then);
    expect(draft.validate(), isNull);
    expect(
      const HookDraft(
        on: ['task.finished'],
        kind: 'notify',
        then: [
          {'kind': 'inject-prompt', 'prompt': ' '},
        ],
      ).validate(),
      '后续步骤的指令不能为空',
    );
    expect(HookRun.fromJson({'ok': true, 'step': 2, 'steps': 3}).steps, 3);
  });

  test('validate catches missing events and webhook url', () {
    expect(const HookDraft(on: [], kind: 'notify').validate(), '请至少选择一个事件');
    expect(
      const HookDraft(
        on: ['task.failed'],
        kind: 'webhook',
        url: ' ',
      ).validate(),
      '请填写 Webhook 地址',
    );
    expect(
      const HookDraft(on: ['task.failed'], kind: 'notify').validate(),
      isNull,
    );
  });

  test(
    'update / setEnabled / remove target the owner route; test expands',
    () async {
      final calls = <http.Request>[];
      final svc = EventTriggerService(
        settings: await mockSettings(),
        httpClient: MockClient((request) async {
          calls.add(request);
          return ok({'ok': true});
        }),
      );
      await svc.setEnabled(item(), false);
      await svc.setEnabled(item(sessionId: 's1'), true);
      await svc.remove(item(sessionId: 's1'));
      await svc.update(
        item(),
        const HookDraft(on: ['task.failed'], kind: 'notify'),
      );
      expect(calls.map((c) => '${c.method} ${c.url.path}').toList(), [
        'PUT /api/event-rules/r1',
        'PUT /api/sessions/s1/triggers/r1',
        'DELETE /api/sessions/s1/triggers/r1',
        'PUT /api/event-rules/r1',
      ]);
      expect(jsonDecode(calls[0].body), {'enabled': false});
      expect(jsonDecode(calls[1].body), {'enabled': true});

      calls.clear();
      await svc.test(item(sessionId: 's1', on: ['task.done']));
      await svc.test(item(on: ['turn.completed']));
      final first = jsonDecode(calls[0].body) as Map<String, dynamic>;
      expect(calls[0].url.path, '/api/events/test');
      expect(first['type'], 'task.achieved', reason: 'task.done 别名展开');
      expect(first['goalState'], 'achieved');
      expect(first['sessionId'], 's1');
      final second = jsonDecode(calls[1].body) as Map<String, dynamic>;
      expect(second['type'], 'turn.completed');
      expect(second.containsKey('sessionId'), isFalse);
    },
  );

  test('server errors surface the error field', () async {
    final svc = EventTriggerService(
      settings: await mockSettings(),
      httpClient: MockClient(
        (_) async => http.Response(jsonEncode({'error': '规则无效'}), 400),
      ),
    );
    expect(
      svc.setEnabled(item(), true),
      throwsA(predicate((e) => e.toString().contains('规则无效'))),
    );
  });

  test('labels and alias expansion', () {
    expect(hookEventLabel('task.failed'), '出错或被中止');
    expect(hookEventLabel('x.y'), 'x.y');
    expect(hookActionLabel('inject-prompt'), '给会话注入指令');
    expect(hookExpandedType('task.attention'), 'task.failed');
    expect(hookExpandedType('task.*'), 'task.finished');
  });

  test(
    'newSession body: blank follows the source, excludes targetSessionId',
    () {
      final action = const HookDraft(
        on: ['task.achieved'],
        kind: 'inject-prompt',
        prompt: ' p ',
        targetSessionId: 's2', // 被 newSession 覆盖，两者互斥
        newSession: HookNewSession(dirId: 'd2', cli: 'codex', title: ' 发布说明 '),
      ).toJson()['action'];
      expect(action, {
        'kind': 'inject-prompt',
        'prompt': 'p',
        'newSession': {'dirId': 'd2', 'cli': 'codex', 'title': '发布说明'},
      });
      expect(
        const HookDraft(
          on: ['task.achieved'],
          kind: 'inject-prompt',
          prompt: 'p',
          newSession: HookNewSession(),
        ).toJson()['action'],
        {
          'kind': 'inject-prompt',
          'prompt': 'p',
          'newSession': {'dirId': '', 'cli': '', 'title': ''},
        },
      );
    },
  );

  test(
    'HookRule parses newSession; fetchClis reads the catalog and fails soft',
    () async {
      final rule = HookRule.fromJson({
        'id': 'r',
        'on': ['task.done'],
        'action': {
          'kind': 'inject-prompt',
          'prompt': 'p',
          'newSession': {'dirId': 'd1', 'cli': 'claude', 'title': 'T'},
        },
      });
      expect(rule.newSession!.dirId, 'd1');
      expect(rule.newSession!.cli, 'claude');
      expect(rule.newSession!.title, 'T');
      expect(
        HookRule.fromJson({
          'id': 'r',
          'on': ['task.done'],
          'action': {'kind': 'inject-prompt'},
        }).newSession,
        isNull,
      );

      final okSvc = EventTriggerService(
        settings: await mockSettings(),
        httpClient: MockClient((request) async {
          expect(request.url.path, '/api/events/catalog');
          return ok({
            'clis': ['claude', 'codex'],
          });
        }),
      );
      expect(await okSvc.fetchClis(), ['claude', 'codex']);

      final failSvc = EventTriggerService(
        settings: await mockSettings(),
        httpClient: MockClient((_) async => http.Response('nope', 500)),
      );
      expect(await failSvc.fetchClis(), isEmpty, reason: '老后端/取不到时不阻塞编辑器');
    },
  );

  Map<String, dynamic> task(
    String id,
    String? sessionId, {
    String status = 'active',
    bool readOnly = false,
    int last = 0,
    String dirId = 'd1',
    String title = '',
  }) => {
    'id': id,
    'dirId': dirId,
    'title': title.isEmpty ? '任务$id' : title,
    'status': status,
    'recordType': 'observed',
    'updatedAt': last,
    'lastMessageAt': last,
    'readOnly': readOnly,
    'sessionId': sessionId,
    'resource': {},
  };

  test('hookSessionChoices lists only live chat sessions, newest first', () {
    final snapshot = AirSnapshot.fromJson({
      'directories': [
        {'id': 'd1', 'name': '主仓', 'path': '/p'},
        {'id': 'd2', 'name': '营销仓', 'path': '/q'},
      ],
      'tasks': [
        task('old', 'task-old', last: 10, title: '旧会话'),
        task('new', 'task-new', last: 30, dirId: 'd2', title: '新会话'),
        task('arch', 'task-arch', status: 'archived', last: 50),
        task('ro', 'task-ro', readOnly: true, last: 60),
        task('none', null, last: 70),
      ],
      // 终端 / 登录终端只在 sessions 里，绝不能出现在注入目标里。
      'sessions': [
        {'id': 'metaads', 'kind': 'terminal'},
        {'id': 'codex-acct-login-x', 'kind': 'terminal'},
      ],
    });
    expect(hookSessionChoices(snapshot), [
      (id: 'task-new', label: '新会话（营销仓）'),
      (id: 'task-old', label: '旧会话（主仓）'),
    ]);
  });

  test(
    'hookSessionChoices lists every session, no cap (search narrows it)',
    () {
      final snapshot = AirSnapshot.fromJson({
        'tasks': [for (var i = 0; i < 300; i++) task('t$i', 's$i', last: i)],
      });
      final choices = hookSessionChoices(snapshot);
      expect(choices, hasLength(300));
      expect(choices.first.id, 's299', reason: '最近活动在前');
      expect(choices.last.label, contains('（—）'), reason: '没有工作区名时用 —');
    },
  );
}
