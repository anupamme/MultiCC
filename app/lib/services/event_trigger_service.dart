import 'dart:convert';

import 'package:http/http.dart' as http;

import 'settings_service.dart';

/// 触发器（事件 → 动作）— 镜像网页 public/hook-editor.js 与
/// public/air-trigger-center.js，后端见 src/events/。
///
/// 一条规则：`on`（事件模式，可多选）发生时执行 `action`。传给下一个动作的参数
/// 是后端拼好的固定信封，这里不让用户定义变量，注入类动作只写「指令」。

/// 事件模式与中文名。别名（task.done / task.attention）放最前。
const List<(String, String)> kHookEvents = [
  ('task.done', '完成（达成目标或需要交互）'),
  ('task.attention', '需要我介入（需要交互 / 等我回答 / 出错）'),
  ('task.achieved', '达成目标'),
  ('task.needs_interaction', '需要交互'),
  ('task.finished', '执行成功（不区分子状态）'),
  ('task.waiting_user', '等待我回答'),
  ('task.waiting_background', '等待后台任务'),
  ('task.failed', '出错或被中止'),
  ('task.running', '开始运行'),
  ('turn.completed', '每轮结束'),
];

const List<(String, String)> kHookActions = [
  ('notify', '通知我'),
  ('webhook', '发送 Webhook'),
  ('inject-prompt', '给会话注入指令'),
];

String hookEventLabel(String pattern) {
  for (final (value, label) in kHookEvents) {
    if (value == pattern) return label;
  }
  return pattern;
}

String hookActionLabel(String kind) {
  for (final (value, label) in kHookActions) {
    if (value == kind) return label;
  }
  return kind;
}

/// 空跑测试用：把别名/通配展开成一个真实事件类型（与网页 expandedType 一致）。
String hookExpandedType(String pattern) {
  if (pattern == 'task.done') return 'task.achieved';
  if (pattern == 'task.attention') return 'task.failed';
  if (pattern == '*' || pattern.endsWith('.*')) return 'task.finished';
  return pattern;
}

class HookRun {
  final int? ts;
  final bool ok;
  final String error;
  const HookRun({this.ts, required this.ok, this.error = ''});

  factory HookRun.fromJson(Map<String, dynamic> j) => HookRun(
    ts: (j['ts'] as num?)?.toInt(),
    ok: j['ok'] == true,
    error: (j['error'] ?? '').toString(),
  );
}

class HookRule {
  final String id;
  final String name;
  final bool enabled;
  final List<String> on;
  final Map<String, dynamic> filter;
  final Map<String, dynamic> action;
  final int cooldownMs;

  const HookRule({
    required this.id,
    required this.name,
    required this.enabled,
    required this.on,
    required this.filter,
    required this.action,
    this.cooldownMs = 0,
  });

  String get kind => (action['kind'] ?? '').toString();
  bool get skipCancelled => filter['cancelled'] == false;
  HookNewSession? get newSession => action['newSession'] is Map
      ? HookNewSession.fromJson(
          (action['newSession'] as Map).cast<String, dynamic>(),
        )
      : null;

  factory HookRule.fromJson(Map<String, dynamic> j) => HookRule(
    id: (j['id'] ?? '').toString(),
    name: (j['name'] ?? '').toString(),
    enabled: j['enabled'] != false,
    on: ((j['on'] as List?) ?? const []).map((e) => e.toString()).toList(),
    filter: ((j['filter'] as Map?) ?? const {}).cast<String, dynamic>(),
    action: ((j['action'] as Map?) ?? const {}).cast<String, dynamic>(),
    cooldownMs: (j['cooldownMs'] as num?)?.toInt() ?? 0,
  );
}

/// 触发器列表里的一行：规则 + 归属（全局 / 某会话）+ 最近一次执行。
class HookItem {
  final String scope; // 'global' | 'session'
  final String? sessionId;
  final String? sessionLabel;
  final HookRule rule;
  final HookRun? lastRun;

  const HookItem({
    required this.scope,
    this.sessionId,
    this.sessionLabel,
    required this.rule,
    this.lastRun,
  });

  bool get isGlobal => sessionId == null;

  factory HookItem.fromJson(Map<String, dynamic> j) => HookItem(
    scope: (j['scope'] ?? 'global').toString(),
    sessionId: j['sessionId']?.toString(),
    sessionLabel: j['sessionLabel']?.toString(),
    rule: HookRule.fromJson((j['rule'] as Map).cast<String, dynamic>()),
    lastRun: j['lastRun'] is Map
        ? HookRun.fromJson((j['lastRun'] as Map).cast<String, dynamic>())
        : null,
  );
}

/// 「新建会话」目标：工作区 / CLI 留空 = 沿用触发事件的会话，标题留空 = 规则名称。
class HookNewSession {
  final String dirId;
  final String cli;
  final String title;
  const HookNewSession({this.dirId = '', this.cli = '', this.title = ''});

  factory HookNewSession.fromJson(Map<String, dynamic> j) => HookNewSession(
    dirId: (j['dirId'] ?? '').toString(),
    cli: (j['cli'] ?? '').toString(),
    title: (j['title'] ?? '').toString(),
  );

  Map<String, dynamic> toJson() => {
    'dirId': dirId,
    'cli': cli,
    'title': title.trim(),
  };
}

/// 编辑器提交的规则草稿。[toJson] 即后端期望的请求体。
class HookDraft {
  final String name;
  final List<String> on;
  final bool skipCancelled;
  final String kind;
  final String message;
  final String url;
  final String secretName;
  final bool includeConclusion;
  final String prompt;
  final String targetSessionId;

  /// 非 null = 每次触发新建一个会话再注入（与 [targetSessionId] 互斥）。
  /// dirId / cli 为空串 = 沿用触发事件的会话。
  final HookNewSession? newSession;
  final int cooldownSeconds;
  final bool enabled;
  final Map<String, dynamic> baseFilter;

  const HookDraft({
    this.name = '',
    required this.on,
    this.skipCancelled = false,
    required this.kind,
    this.message = '',
    this.url = '',
    this.secretName = '',
    this.includeConclusion = false,
    this.prompt = '',
    this.targetSessionId = '',
    this.newSession,
    this.cooldownSeconds = 0,
    this.enabled = true,
    this.baseFilter = const {},
  });

  /// 本地校验；返回错误文案，null 表示通过。
  String? validate() {
    if (on.isEmpty) return '请至少选择一个事件';
    if (kind == 'webhook' && url.trim().isEmpty) return '请填写 Webhook 地址';
    return null;
  }

  Map<String, dynamic> toJson() {
    final action = <String, dynamic>{'kind': kind};
    if (kind == 'notify') {
      action['message'] = message.trim();
    } else if (kind == 'webhook') {
      action['url'] = url.trim();
      if (secretName.isNotEmpty) action['secretName'] = secretName;
      action['includeConclusion'] = includeConclusion;
    } else {
      action['prompt'] = prompt.trim();
      if (newSession != null) {
        action['newSession'] = newSession!.toJson();
      } else if (targetSessionId.isNotEmpty) {
        action['targetSessionId'] = targetSessionId;
      }
    }
    final filter = Map<String, dynamic>.from(baseFilter);
    if (skipCancelled) {
      filter['cancelled'] = false;
    } else {
      filter.remove('cancelled');
    }
    return {
      'type': 'event',
      'name': name.trim(),
      'on': on,
      'filter': filter,
      'action': action,
      'enabled': enabled,
      'cooldownMs': cooldownSeconds < 0 ? 0 : cooldownSeconds * 1000,
    };
  }
}

class EventTriggerService {
  final SettingsService settings;

  /// 测试可注入 MockClient；生产为 null，走 package 级 http 函数。
  final http.Client? httpClient;
  EventTriggerService({required this.settings, this.httpClient});

  Map<String, String> get _headers {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (settings.token.isNotEmpty) h['X-Access-Token'] = settings.token;
    return h;
  }

  Future<http.Response> _send(String method, String path, {Object? body}) {
    final uri = Uri.parse(settings.buildHttpUrl(path));
    final c = httpClient;
    final encoded = body == null ? null : jsonEncode(body);
    final call = switch (method) {
      'GET' =>
        c == null
            ? http.get(uri, headers: _headers)
            : c.get(uri, headers: _headers),
      'POST' =>
        c == null
            ? http.post(uri, headers: _headers, body: encoded)
            : c.post(uri, headers: _headers, body: encoded),
      'PUT' =>
        c == null
            ? http.put(uri, headers: _headers, body: encoded)
            : c.put(uri, headers: _headers, body: encoded),
      'DELETE' =>
        c == null
            ? http.delete(uri, headers: _headers)
            : c.delete(uri, headers: _headers),
      _ => throw ArgumentError.value(method, 'method', '不支持的方法'),
    };
    return call.timeout(const Duration(seconds: 10));
  }

  Never _fail(http.Response res) {
    String? msg;
    try {
      final j = jsonDecode(utf8.decode(res.bodyBytes));
      if (j is Map && j['error'] != null) msg = j['error'].toString();
    } catch (_) {}
    throw Exception(msg ?? 'HTTP ${res.statusCode}');
  }

  Object? _json(http.Response res) {
    if (res.statusCode < 200 || res.statusCode >= 300) _fail(res);
    if (res.bodyBytes.isEmpty) return null;
    return jsonDecode(utf8.decode(res.bodyBytes));
  }

  String _itemPath(HookItem item) => item.sessionId != null
      ? '/api/sessions/${Uri.encodeComponent(item.sessionId!)}/triggers/${Uri.encodeComponent(item.rule.id)}'
      : '/api/event-rules/${Uri.encodeComponent(item.rule.id)}';

  /// 后端支持新建会话的 CLI 清单；取不到时返回空（编辑器只留「同来源会话」）。
  Future<List<String>> fetchClis() async {
    try {
      final data = _json(await _send('GET', '/api/events/catalog'));
      final list = (data is Map ? data['clis'] : null) as List? ?? const [];
      return list.map((e) => e.toString()).toList();
    } catch (_) {
      return const [];
    }
  }

  /// 全局 + 各会话的事件触发器，含最近一次执行结果。
  Future<List<HookItem>> fetchAll() async {
    final data = _json(await _send('GET', '/api/event-triggers'));
    final items = (data is Map ? data['items'] : null) as List? ?? const [];
    return items
        .map((e) => HookItem.fromJson((e as Map).cast<String, dynamic>()))
        .toList();
  }

  /// 创建；[sessionId] 为空 = 全局规则。
  Future<void> create(HookDraft draft, {String? sessionId}) async {
    final path = sessionId == null || sessionId.isEmpty
        ? '/api/event-rules'
        : '/api/sessions/${Uri.encodeComponent(sessionId)}/triggers';
    _json(await _send('POST', path, body: draft.toJson()));
  }

  Future<void> update(HookItem item, HookDraft draft) async {
    _json(await _send('PUT', _itemPath(item), body: draft.toJson()));
  }

  Future<void> setEnabled(HookItem item, bool enabled) async {
    _json(await _send('PUT', _itemPath(item), body: {'enabled': enabled}));
  }

  Future<void> remove(HookItem item) async {
    _json(await _send('DELETE', _itemPath(item)));
  }

  /// 空跑：发一个模拟事件，让这条规则真的走一遍匹配与动作。
  Future<void> test(HookItem item) async {
    final type = hookExpandedType(item.rule.on.first);
    final goalState =
        item.rule.filter['goalState'] ??
        (type == 'task.achieved'
            ? 'achieved'
            : (type == 'task.needs_interaction' ? 'interact' : null));
    _json(
      await _send(
        'POST',
        '/api/events/test',
        body: {
          'type': type,
          if (item.sessionId != null) 'sessionId': item.sessionId,
          'goalState': goalState,
          'goal': '（测试事件）',
        },
      ),
    );
  }
}
