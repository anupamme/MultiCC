import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import '../i18n.dart';
import '../services/air_service.dart';
import '../services/chat_service.dart';
import '../services/settings_service.dart';
import '../services/task_directory_hint.dart';

/// 「这个任务更适合放在『某目录』」提示卡。
///
/// 数据来自任务归集裁决的 `directoryHint`（读
/// `/api/task-shells/:shellId/attribution-decisions`，并监听 WS
/// `task_attribution_updated`）。它只提示，绝不自动迁移：用户在卡上点
/// 「迁移过去」后才调用任务级 relocate；点「忽略」只 dismiss 这条裁决。
class TaskDirectoryHintPrompt extends StatefulWidget {
  final Stream<ChatEvent> events;
  final String? shellId;
  final http.Client? httpClient;
  final SettingsService settings;

  /// 迁移成功后的刷新钩子（App 里接 [SessionManager.loadDashboard]，把目录/
  /// 任务列表重新拉一遍）。widget 也会自己重读目录名。
  final Future<void> Function()? onRelocated;
  final Widget child;

  const TaskDirectoryHintPrompt({
    super.key,
    required this.events,
    required this.shellId,
    this.httpClient,
    required this.settings,
    this.onRelocated,
    required this.child,
  });

  @override
  State<TaskDirectoryHintPrompt> createState() =>
      _TaskDirectoryHintPromptState();
}

class _TaskDirectoryHintPromptState extends State<TaskDirectoryHintPrompt> {
  static const _refreshEvents = {
    'task_state',
    'system_init',
    'chat_msg_meta',
    'state_change',
    'task_attribution_updated',
  };

  StreamSubscription<ChatEvent>? _events;
  Object? _stream;
  bool _loading = false;
  bool _again = false;
  String? _displayed;
  DialogRoute<void>? _dialog;
  AirService? _air;
  final Set<String> _resolved = {};
  // accept 返回 `queued` 的行：归属变更要等当前轮次结束。卡片必须留着让用户
  // 稍后重试；这期间读接口可能把它标成 queued，之后还会变成 applied ——
  // 两种状态都不能把卡片悄悄收掉。
  final Map<String, TaskDirectoryHint> _queuedHints = {};
  final Map<String, String> _directoryNames = {};

  AirService get _airService => _air ??= AirService(
    settings: widget.settings,
    httpClient: widget.httpClient,
  );

  @override
  void initState() {
    super.initState();
    _subscribe();
  }

  @override
  void didUpdateWidget(TaskDirectoryHintPrompt oldWidget) {
    super.didUpdateWidget(oldWidget);
    _subscribe();
    if (oldWidget.shellId != widget.shellId) {
      // 换壳 = 换一份裁决清单；旧卡和旧去重结果都不再适用。
      _close();
      _resolved.clear();
      _queuedHints.clear();
      _directoryNames.clear();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _refresh();
      });
    }
  }

  void _subscribe() {
    final stream = widget.events;
    // 同 TaskSeparationPrompt：广播控制器的 `.stream` 每次 get 都是新包装对象，
    // 必须按 == 判等，否则每次重建都会重订阅并立刻请求一次。
    if (stream == _stream) return;
    _events?.cancel();
    _stream = stream;
    _events = stream.listen((event) {
      if (_refreshEvents.contains(event.type)) unawaited(_refresh());
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _refresh();
    });
  }

  String get _shellId => (widget.shellId ?? '').trim();

  String _errorCode(Object error) {
    if (error is AirTaskActionException) return error.code;
    if (error is _DecisionApiException) return error.code;
    return '$error';
  }

  Future<Map<String, dynamic>> _request(
    String method,
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    final uri = Uri.parse(widget.settings.buildHttpUrl(path));
    final headers = <String, String>{
      'Content-Type': 'application/json',
      if (widget.settings.token.isNotEmpty)
        'X-Access-Token': widget.settings.token,
    };
    final encoded = body == null ? null : jsonEncode(body);
    final pending = method == 'POST'
        ? (widget.httpClient?.post(uri, headers: headers, body: encoded) ??
              http.post(uri, headers: headers, body: encoded))
        : (widget.httpClient?.get(uri, headers: headers) ??
              http.get(uri, headers: headers));
    final response = await pending.timeout(const Duration(seconds: 30));
    var data = const <String, dynamic>{};
    try {
      final decoded = jsonDecode(utf8.decode(response.bodyBytes));
      if (decoded is Map) {
        data = decoded.cast<String, dynamic>();
      }
    } catch (_) {
      // 下面的状态码分支会把「不是 JSON」报成 HTTP 错误。
    }
    if (response.statusCode >= 400 || data['ok'] == false) {
      throw _DecisionApiException(
        '${data['code'] ?? data['message'] ?? 'HTTP ${response.statusCode}'}',
      );
    }
    return data;
  }

  Future<Object?> _decisions(String shellId) async {
    final data = await _request(
      'GET',
      '/api/task-shells/${Uri.encodeComponent(shellId)}/attribution-decisions',
    );
    return data['decisions'];
  }

  String? _decisionState(Object? decisions, String id) {
    if (decisions is! List) return null;
    for (final row in decisions) {
      if (row is Map && row['id']?.toString() == id) {
        return row['state']?.toString();
      }
    }
    return null;
  }

  Future<Map<String, dynamic>> _decide(
    String shellId,
    String decisionId,
    String action, {
    Map<String, dynamic>? body,
  }) => _request(
    'POST',
    '/api/task-shells/${Uri.encodeComponent(shellId)}/attribution-decisions/'
        '${Uri.encodeComponent(decisionId)}/$action',
    body ?? const {},
  );

  String _newClientMsgId() =>
      'app-hint-${DateTime.now().microsecondsSinceEpoch}';

  Future<String> _directoryName(String dirId) async {
    final cached = _directoryNames[dirId];
    if (cached != null) return cached;
    try {
      final snapshot = await _airService.load();
      for (final directory in snapshot.directories) {
        _directoryNames[directory.id] = directory.name;
      }
    } catch (_) {
      // 目录名取不到就退回 id —— 卡片还能看，迁移接口自己会校验目录。
    }
    return _directoryNames[dirId] ?? dirId;
  }

  Future<void> _refreshDirectories() async {
    _directoryNames.clear();
    try {
      final snapshot = await _airService.load();
      for (final directory in snapshot.directories) {
        _directoryNames[directory.id] = directory.name;
      }
    } catch (_) {}
  }

  void _close() {
    final route = _dialog;
    _dialog = null;
    _displayed = null;
    if (route?.isActive == true) route!.navigator?.removeRoute(route);
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    if (_loading) {
      _again = true;
      return;
    }
    if (ModalRoute.of(context)?.isCurrent == false && _dialog == null) return;
    final shellId = _shellId;
    if (shellId.isEmpty) {
      _close();
      return;
    }
    _loading = true;
    try {
      final decisions = await _decisions(shellId);
      if (!mounted) return;
      if (shellId != _shellId) {
        _again = true;
        return;
      }
      final hints = taskDirectoryHintsFromDecisions(
        decisions,
        resolved: _resolved,
      );
      // 已经有一张卡开着时，优先让它留在原地：用户正在读这一条，不能被
      // 下一条建议顶掉。只有那行被外部解决（消失/忽略/还原）才收起。
      final current = _displayed;
      if (current != null && _dialog != null) {
        final state = _decisionState(decisions, current);
        final keep =
            hints.any((hint) => hint.decisionId == current) ||
            (_queuedHints.containsKey(current) &&
                (state == 'queued' ||
                    state == 'pending' ||
                    state == 'deferred' ||
                    state == 'applied'));
        if (keep) return;
        _queuedHints.remove(current);
        _close();
      }
      if (hints.isEmpty) return;
      final hint = hints.first;
      await _show(hint, shellId);
    } catch (error) {
      debugPrint('Task directory hint: $error');
    } finally {
      _loading = false;
      if (_again && mounted) {
        _again = false;
        unawaited(_refresh());
      }
    }
  }

  Future<void> _show(TaskDirectoryHint hint, String shellId) async {
    final directoryName = await _directoryName(hint.dirId);
    if (!mounted || shellId != _shellId) return;
    _displayed = hint.decisionId;
    var saving = false;
    String? error;
    final route = DialogRoute<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, update) {
          Future<void> ignore() async {
            if (saving) return;
            update(() {
              saving = true;
              error = null;
            });
            try {
              await _decide(shellId, hint.decisionId, 'dismiss');
              _resolved.add(hint.decisionId);
              _queuedHints.remove(hint.decisionId);
              _close();
            } catch (e) {
              if (dialogContext.mounted) {
                update(() {
                  saving = false;
                  error = t('taskDirectoryHintDismissFailed', {
                    'error': _errorCode(e),
                  });
                });
              }
            }
          }

          Future<void> move() async {
            if (saving) return;
            update(() {
              saving = true;
              error = null;
            });
            try {
              // 契约：新任务归属（identity）先走原有 accept；纯 hint 行
              // （path:'none'）不能 accept，只 relocate。
              if (hint.needsAccept) {
                final accepted = await _decide(
                  shellId,
                  hint.decisionId,
                  'accept',
                  body: {'clientMsgId': _newClientMsgId()},
                );
                final state = (accepted['state'] ?? '').toString();
                if (state == 'queued') {
                  _queuedHints[hint.decisionId] = hint;
                  if (dialogContext.mounted) {
                    update(() {
                      saving = false;
                      error = t('taskDirectoryHintQueued');
                    });
                  }
                  return;
                }
              }
              final taskId = hint.targetTaskId;
              if (taskId == null) {
                throw const _DecisionApiException('task_not_found');
              }
              await _airService.relocateTask(taskId, hint.dirId);
              // 迁移已成功；dismiss 失败不改变结果，下次读接口会看到它已
              // 被 resolve。
              try {
                await _decide(shellId, hint.decisionId, 'dismiss');
              } catch (_) {}
              _resolved.add(hint.decisionId);
              _queuedHints.remove(hint.decisionId);
              _close();
              await _refreshDirectories();
              try {
                await widget.onRelocated?.call();
              } catch (_) {}
              if (!mounted) return;
              ScaffoldMessenger.maybeOf(this.context)?.showSnackBar(
                SnackBar(
                  content: Text(
                    t('taskDirectoryHintMoved', {'dir': directoryName}),
                  ),
                ),
              );
            } catch (e) {
              final code = _errorCode(e);
              final key = directoryHintErrorKey(code);
              final message = key != null
                  ? t(key)
                  : t('taskDirectoryHintFailed', {'error': code});
              if (dialogContext.mounted) {
                update(() {
                  saving = false;
                  error = message;
                });
              }
            }
          }

          return PopScope(
            canPop: false,
            child: AlertDialog(
              title: Text(t('taskDirectoryHintTitle')),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      t('taskDirectoryHintBody', {
                        'dir': directoryName,
                        'reason': hint.reason,
                      }),
                    ),
                    if (error != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: saving ? null : ignore,
                  child: Text(t('taskDirectoryHintIgnore')),
                ),
                FilledButton(
                  onPressed: saving ? null : move,
                  child: Text(t('taskDirectoryHintMove')),
                ),
              ],
            ),
          );
        },
      ),
    );
    _dialog = route;
    unawaited(Navigator.of(context).push(route));
  }

  @override
  void dispose() {
    _events?.cancel();
    _close();
    _air?.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class _DecisionApiException implements Exception {
  const _DecisionApiException(this.code);
  final String code;

  @override
  String toString() => code;
}
