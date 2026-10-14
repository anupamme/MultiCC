import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

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

  test('create posts to the global or session route with the draft body',
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
      'enabled': true,
      'cooldownMs': 30000,
    });
  });

  test('draft body per kind: notify message, inject prompt + target', () {
    expect(
      const HookDraft(on: ['task.failed'], kind: 'notify', message: ' m ')
          .toJson()['action'],
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
      const HookDraft(on: ['task.achieved'], kind: 'inject-prompt', prompt: 'p')
          .toJson()['action'],
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

  test('validate catches missing events and webhook url', () {
    expect(const HookDraft(on: [], kind: 'notify').validate(), '请至少选择一个事件');
    expect(
      const HookDraft(on: ['task.failed'], kind: 'webhook', url: ' ').validate(),
      '请填写 Webhook 地址',
    );
    expect(
      const HookDraft(on: ['task.failed'], kind: 'notify').validate(),
      isNull,
    );
  });

  test('update / setEnabled / remove target the owner route; test expands', () async {
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
    expect(
      calls.map((c) => '${c.method} ${c.url.path}').toList(),
      [
        'PUT /api/event-rules/r1',
        'PUT /api/sessions/s1/triggers/r1',
        'DELETE /api/sessions/s1/triggers/r1',
        'PUT /api/event-rules/r1',
      ],
    );
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
  });

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
}
