/// 任务归集判定里的「目录归属建议」（`directoryHint`）。
///
/// 服务端只把它当建议：客户端读出这条记录、展示一张卡，用户点了才走任务级
/// `POST /api/task-board/tasks/:taskId/relocate`。这里只做纯解析/去重/错误码
/// 映射，网络与界面都在 widget 层，方便单测钉死契约。
class TaskDirectoryHint {
  const TaskDirectoryHint({
    required this.decisionId,
    required this.fromTaskId,
    required this.toTaskId,
    required this.path,
    required this.state,
    required this.dirId,
    required this.reason,
  });

  /// 裁决行 id（`attr-decision` 的 `dec.id`）。
  final String decisionId;

  /// 判定里的源任务 —— 迁移的兜底目标（契约：`toTaskId || fromTaskId`）。
  final String fromTaskId;

  /// 判定给出的目标任务；纯目录建议（`path:'none'`）时为 null。
  final String? toTaskId;

  /// `identity` / `overlay` / `none`。只有 `identity` 需要先 accept。
  final String path;

  /// 裁决行的状态（`pending` / `deferred` / `queued` …）。
  final String state;

  /// 目标目录 id。
  final String dirId;

  /// 服务端给出的建议理由（已截断到 240 字符）。
  final String reason;

  /// 迁移的目标任务：契约规定 `toTaskId || fromTaskId`。
  String? get targetTaskId {
    final to = (toTaskId ?? '').trim();
    if (to.isNotEmpty) return to;
    final from = fromTaskId.trim();
    return from.isEmpty ? null : from;
  }

  /// 只有新任务归属（`path:'identity'`）要先走原有 accept；纯建议行
  /// （`path:'none'`）服务端不接受 accept，只能直接 relocate。
  bool get needsAccept =>
      path == 'identity' && (toTaskId ?? '').trim().isNotEmpty;

  /// 同一任务的同一目录只提示一次。服务端也按这个口径去重，客户端再兜一层，
  /// 免得同一行在多页/刷新之间来回出现两张卡。
  String get dedupeKey => '$fromTaskId|$dirId';
}

/// 把一条裁决 DTO 解析成目录建议；不满足契约就返回 null。
///
/// `hidden` 行是 shadow 档，用户从没见过，客户端也不该把它变成提示。
TaskDirectoryHint? parseTaskDirectoryHint(Object? decision) {
  if (decision is! Map) return null;
  if (decision['hidden'] == true) return null;
  final hint = decision['directoryHint'];
  if (hint is! Map) return null;
  final dirId = (hint['dirId'] ?? '').toString().trim();
  final reason = (hint['reason'] ?? '').toString().trim();
  final id = (decision['id'] ?? '').toString().trim();
  final from = (decision['fromTaskId'] ?? '').toString().trim();
  if (id.isEmpty || from.isEmpty || dirId.isEmpty || reason.isEmpty) {
    return null;
  }
  final to = (decision['toTaskId'] ?? '').toString().trim();
  return TaskDirectoryHint(
    decisionId: id,
    fromTaskId: from,
    toTaskId: to.isEmpty ? null : to,
    path: (decision['path'] ?? '').toString().trim(),
    state: (decision['state'] ?? '').toString().trim(),
    dirId: dirId,
    reason: reason,
  );
}

/// 可以现在动手的行：`pending` / `deferred`。
///
/// `queued` 表示归属变更已经排在一轮运行之后，此时再迁移会和它抢同一个
/// 任务，所以卡片先不出现，等那行落定后由广播重新触发。
bool isTaskDirectoryHintActionable(TaskDirectoryHint hint) =>
    hint.state == 'pending' || hint.state == 'deferred';

/// 从 `GET /api/task-shells/:shellId/attribution-decisions` 的数组里挑出
/// 可展示的目录建议。
///
/// 去重两条：同一裁决 id 只留第一行；同一「源任务 + 目标目录」只留第一行。
/// [resolved] 是本页已经点过「迁移/忽略」的 id —— 服务端广播与下一次读接口
/// 可能还没追上，客户端先按本地结果收口，避免卡片闪回来。
List<TaskDirectoryHint> taskDirectoryHintsFromDecisions(
  Object? decisions, {
  Set<String> resolved = const {},
}) {
  if (decisions is! List) return const [];
  final seenIds = <String>{};
  final seenKeys = <String>{};
  final hints = <TaskDirectoryHint>[];
  for (final decision in decisions) {
    final hint = parseTaskDirectoryHint(decision);
    if (hint == null) continue;
    if (!isTaskDirectoryHintActionable(hint)) continue;
    if (resolved.contains(hint.decisionId)) continue;
    if (!seenIds.add(hint.decisionId)) continue;
    if (!seenKeys.add(hint.dedupeKey)) continue;
    hints.add(hint);
  }
  return hints;
}

/// 任务级迁移失败码 → i18n key。没有映射的码由界面按通用失败文案展示，
/// 把服务端码原样留在冒号后面，诊断信息不丢。
String? directoryHintErrorKey(String code) {
  switch (code) {
    case 'task_busy':
      return 'taskDirectoryHintBusy';
    case 'task_archived':
      return 'taskDirectoryHintArchived';
    case 'task_shell_shared':
      return 'taskDirectoryHintShared';
    case 'target directory not found':
      return 'taskDirectoryHintTargetMissing';
    case 'task_deleting':
      return 'taskDirectoryHintDeleting';
    default:
      return null;
  }
}
