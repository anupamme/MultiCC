/// Air 侧「这条任务算什么、在不在跑」的唯一判定 —— 对应 Web
/// `public/air-admin.js` 顶部那一段（`taskStatus` / `isRunning` /
/// `taskDetail`）。
///
/// 判定权不在这一层，在 `utils/status_presentation.dart` 的
/// `statusPresentation`：那边只给 running 设了 spinner，于是「出错的任务绝不动
/// 画」是一条规则，而不是每个用到状态的地方各判一遍。侧栏、任务行、控制台统计
/// 都从这里取值，所以同一条任务在两个地方不可能显示成两种状态。
library;

import 'package:flutter/material.dart';

import '../../services/air_service.dart';
import '../../utils/status_presentation.dart';

/// 生命周期（archived/done）优先，其次是这一轮的 [AirTask.runState]。
CanonicalStatus airTaskStatus(AirTask task) =>
    taskStatusOf(status: task.status, runState: task.runState);

/// 本轮成功或旧生命周期 done，且最后更新时间落在本地今天。
/// Web 对应 `public/air-admin.js` 的 `doneToday`；目录首页和控制台共用这一份。
bool airTaskDoneToday(AirTask task, [DateTime? now]) {
  if (airTaskStatus(task) != CanonicalStatus.succeeded &&
      task.status != 'done') {
    return false;
  }
  final at = now ?? DateTime.now();
  final midnight = DateTime(at.year, at.month, at.day);
  return task.updatedAt >= midnight.millisecondsSinceEpoch;
}

/// Shared by directory counters and their result list (same rules as Web).
///
/// [needsMe] 是系统汇总口径（等待回复 / 异常 / 需要交互 / 手动待办，排除归档与
/// 已忽略）；[todo] 只表示用户手动标记的待办。两者在筛选下拉里并列，互不包含。
enum AirDirectoryTaskFilter {
  needsMe('等我处理'),
  todo('待办'),
  open('进行中与待处理'),
  running('运行中'),
  waiting('等待回复'),
  error('异常'),
  today('今日完成'),
  succeeded('执行成功'),
  achieved('完成目标'),
  interact('需要交互'),
  all('全部记录'),
  archived('已归档');

  const AirDirectoryTaskFilter(this.label);
  final String label;

  String get apiValue => switch (this) {
    needsMe => 'needs',
    waiting => 'waitingReply',
    _ => name,
  };
  String get countKey => this == all ? 'total' : apiValue;

  bool matches(AirTask task) => switch (this) {
    needsMe => airTaskNeedsMe(task),
    todo => task.manualTodo,
    open => task.status != 'done' && task.status != 'archived',
    running => airTaskRunning(task),
    waiting => airTaskStatus(task) == CanonicalStatus.waiting,
    error => airTaskStatus(task) == CanonicalStatus.error,
    today => airTaskDoneToday(task),
    succeeded => airTaskStatus(task) == CanonicalStatus.succeeded,
    achieved =>
      airTaskStatus(task) == CanonicalStatus.succeeded &&
          task.goalState == 'achieved',
    interact =>
      airTaskStatus(task) == CanonicalStatus.succeeded &&
          task.goalState == 'interact',
    all => true,
    archived => task.status == 'archived',
  };
}

/// 「等我处理」：需要我接手的四类任务放在一起 —— 等待用户输入（waiting）、出错
/// （error）、执行成功但需要交互（succeeded + goalState=interact），以及手动标记
/// 为待办的（[AirTask.manualTodo]）。归档的和用户手动忽略的都不算；手动标记的
/// 任务即便已经完成也留着，直到用户自己取消。Web 对应
/// `public/air-task-todo.js` 的 `isTodo`。
bool airTaskNeedsMe(AirTask task) {
  if (task.status == 'archived') return false;
  // 用户说了「这条先别提醒我」：忽略压过运行态和手动标记，直到服务端因为新
  // 动静（或用户取消忽略）把它从忽略清单里拿掉。统计、徽标都走这一条判定。
  if (task.todoIgnored) return false;
  if (task.manualTodo) return true;
  final status = airTaskStatus(task);
  return status == CanonicalStatus.waiting ||
      status == CanonicalStatus.error ||
      (status == CanonicalStatus.succeeded && task.goalState == 'interact');
}

/// 旧名保留：大量调用点与测试仍按「待办」称呼这份汇总口径。新代码请用
/// [airTaskNeedsMe]（汇总叫「等我处理」，手动标记才叫「待办」）。
bool airTaskTodo(AirTask task) => airTaskNeedsMe(task);

/// 任务行上唯一那颗动作按钮该做什么。优先级：
/// 已忽略（取消忽略）> 手动标记（取消待办）> 随状态的动作 > 标记待办。
/// 忽略与手动待办在服务端是两份独立清单，这里只决定先展示哪一个。
enum AirTaskAction {
  unignore,
  unmarkTodo,
  ignoreError,
  ignoreWaiting,
  markAchieved,
  markTodo,
}

AirTaskAction airTaskPrimaryAction(AirTask task) {
  if (task.todoIgnored) return AirTaskAction.unignore;
  if (task.manualTodo) return AirTaskAction.unmarkTodo;
  final status = airTaskStatus(task);
  if (status == CanonicalStatus.error) return AirTaskAction.ignoreError;
  if (status == CanonicalStatus.waiting) return AirTaskAction.ignoreWaiting;
  if (status == CanonicalStatus.succeeded && task.goalState == 'interact') {
    return AirTaskAction.markAchieved;
  }
  return AirTaskAction.markTodo;
}

extension AirTaskActionPresentation on AirTaskAction {
  String get labelKey => switch (this) {
    AirTaskAction.unignore => 'airTodoUnignore',
    AirTaskAction.unmarkTodo => 'airTodoUnmark',
    AirTaskAction.ignoreError => 'airTodoIgnoreError',
    AirTaskAction.ignoreWaiting => 'airTodoIgnoreWaiting',
    AirTaskAction.markAchieved => 'airTodoMarkAchieved',
    AirTaskAction.markTodo => 'airTodoMark',
  };

  IconData get icon => switch (this) {
    AirTaskAction.unignore => Icons.visibility_rounded,
    AirTaskAction.unmarkTodo => Icons.flag_rounded,
    AirTaskAction.ignoreError ||
    AirTaskAction.ignoreWaiting => Icons.visibility_off_outlined,
    AirTaskAction.markAchieved => Icons.check_circle_outline_rounded,
    AirTaskAction.markTodo => Icons.outlined_flag_rounded,
  };

  /// 走 `/api/air/todos/ignore` 的三种动作（忽略 / 取消忽略）。
  bool get usesIgnoreEndpoint =>
      this == AirTaskAction.unignore ||
      this == AirTaskAction.ignoreError ||
      this == AirTaskAction.ignoreWaiting;
}

StatusSpec airTaskSpec(AirTask task) =>
    statusSpecOf(StatusDomain.task, airTaskStatus(task));

/// Air 面上每个状态叫什么 —— **只有一份**，在注册表的 `airLabelKey` 列上
/// （`utils/status_presentation.dart` 的 [StatusSpec.airLabel]）。Web 侧同一列由
/// `public/status-presentation.js` 的 `airStatusLabels()` 出，`air.js` 的
/// `stateNames` 与控制台的 `STATUS_COPY` 都从它构建。
///
/// 为什么不直接用注册表的 `labelKey`（App 词典里 running 是「进行中」、waiting 是
/// 「等待中」）：Air 面自带一份中文，说的是跟阶段、资源去向（[airLabel]）同源的那
/// 套词。两套词混着用，同一行就会冒出两个词说同一件事 —— 徽标写「进行中」、旁边那
/// 行写「执行中」，读的人得先猜它们是不是一回事。所以 Air 词表单独占注册表的一列，
/// 而不是在这里再抄一份：手抄的那几份已经漂了（一条在等后台任务、不需要任何人回答
/// 的卡，曾被这一列写成「等待回答」）。
String airStatusLabel(CanonicalStatus status) => airStatusWord(status);

/// 整张表（枚举 → Air 词）。给需要遍历的地方和测试用；取单个状态的词走
/// [airStatusLabel]。
Map<CanonicalStatus, String> airStatusCopy() => airStatusWords();

/// Air 面的状态徽标：词走 [airStatusCopy]，可见文案和无障碍名是同一个词（同 Web
/// `statusBadge()` 那句「translate 恒等于可见文案」）。侧栏的任务行、目录首页的
/// 任务卡都从这里取，所以一条任务在两个地方不可能写成两种状态。
class AirTaskStatusBadge extends StatelessWidget {
  const AirTaskStatusBadge({
    super.key,
    required this.task,
    this.fontSize = 10.5,
    this.dense = false,
  });

  final AirTask task;
  final double fontSize;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final status = airTaskStatus(task);
    // ✅ 那一格有三个说法（执行成功 / 需要交互 / 达成目标）：服务端在判定 D 时算
    // 好子状态随卡片一起来，这里只负责换词，图标、色调、排序都不动。认不出来就
    // 退回「执行成功」。同 Web 的 `statusBadge()`。
    final word = succeededSubLabel(status, task.goalState);
    final shown = word.isEmpty ? airStatusLabel(status) : word;
    // 色调覆写同 Web 的 `statusBadge()`：达成目标留绿，需要交互转黄，没判定
    // 出来转灰 —— 三种子状态不止靠旁边的字分开。
    final toneOverride = succeededGoalTone(status, task.goalState);
    return StatusBadge(
      domain: StatusDomain.task,
      status: status,
      label: shown,
      semanticLabel: shown,
      fontSize: fontSize,
      dense: dense,
      toneOverride: toneOverride.isEmpty ? null : toneOverride,
    );
  }
}

String airWorktreeChangeLabel(AirTask task) {
  final changes = task.worktreeChanges;
  if (changes == null || !changes.pending) return '';
  if (changes.dirty && changes.ahead > 0) {
    return 'Worktree 有未提交改动，另有 ${changes.ahead} 个提交尚未合并';
  }
  if (changes.dirty) return 'Worktree 有未提交改动';
  return 'Worktree 有 ${changes.ahead} 个提交尚未合并';
}

/// Web `.worktree-change-badge` 的 App 对位件：静态琥珀色分支图标，tooltip 与
/// 无障碍名区分「未提交」和「已提交但未合回」。不做常驻动画。
class AirWorktreeChangeBadge extends StatelessWidget {
  const AirWorktreeChangeBadge({super.key, required this.task});

  final AirTask task;

  @override
  Widget build(BuildContext context) {
    final label = airWorktreeChangeLabel(task);
    if (label.isEmpty) return const SizedBox.shrink();
    return Tooltip(
      message: label,
      child: Semantics(
        label: label,
        image: true,
        child: Container(
          key: ValueKey('air-worktree-change-${task.id}'),
          width: 18,
          height: 18,
          decoration: BoxDecoration(
            color: const Color(0xfffff7df),
            border: Border.all(color: const Color(0xffe8c982)),
            borderRadius: BorderRadius.circular(6),
          ),
          child: const Icon(
            Icons.merge_type_rounded,
            size: 13,
            color: Color(0xff98630c),
          ),
        ),
      ),
    );
  }
}

/// 只有注册表说 spinner 的状态才配转圈 —— 「在跑」全局只有这一个定义，所以这
/// 里不写 `runState == 'running'`。
bool airTaskRunning(AirTask task) => airTaskSpec(task).spinner;

/// 有任务正在执行的目录。目录行上那个「有活在跑」的标记用它。
Set<String> airRunningDirectories(Iterable<AirTask> tasks) => {
  for (final task in tasks)
    if (airTaskRunning(task)) task.dirId,
};

/// 控制台「等我处理」分区的完整清单，也是侧栏徽标、统计格和移动工作区卡片的
/// 唯一来源。Web 的 `todoTasks(data)` 与它是同一份口径。
///
/// 顺序是**最早的消息时间在前**（`lastMessageAt`，没有消息时间才退回
/// `updatedAt`）：等我处理不是「最近发生了什么」，而是「哪件事等我最久」——先
/// 处理老问题才不会再压出新的。同一条时间戳再按 id 兜底，两次渲染的顺序因此稳定。
List<AirTask> airNeedsMeTasks(Iterable<AirTask> tasks) {
  int todoAt(AirTask task) =>
      task.lastMessageAt > 0 ? task.lastMessageAt : task.updatedAt;
  return tasks.where(airTaskNeedsMe).toList()..sort((a, b) {
    final byTime = todoAt(a).compareTo(todoAt(b));
    return byTime != 0 ? byTime : a.id.compareTo(b.id);
  });
}

/// 旧名保留：历史调用点与测试仍按「待办清单」称呼这份汇总清单。
List<AirTask> airTodoTasks(Iterable<AirTask> tasks) => airNeedsMeTasks(tasks);

/// 任务行的第二层信息：状态徽标已经说了「在不在跑」，这里补记录类型、阶段和
/// 资源去向（同 Web 的 `taskDetail`）。
///
/// 阶段（看板那一列）只有计划记录才有 —— `workflowStage` 是那类记录自己的字段，
/// 观察型记录（从对话里长出来的任务）永远是 null。所以不要拿 `status` 兜底：它是
/// 生命周期（active/done/archived），跟「在不在跑」无关，翻出来是「进行中」，
/// 而同一行上的徽标正说着「空闲」/「执行成功」—— 一行话自相矛盾。Web 的侧栏
/// （`public/air.js` 的 `renderSidebarTasks`）早就是这个规矩：非计划记录不出阶段词。
String airTaskDetail(AirTask task) {
  final stage = task.recordType == 'planned'
      ? airLabel(task.workflowStage ?? task.status)
      : '';
  final bits = <String>[if (stage.isNotEmpty) '计划 · $stage'];
  final held = task.resourceText;
  // 徽标已经说过的词不在这里再说一遍（「执行中 · 执行中」不是更多信息）——
  // 同 Web 侧栏那句 `!badgeText.includes(part)`。比的是徽标上那个词（[airStatusCopy]），
  // 不是词典里的词：一行上只有一套词的时候，这两句才真的能对上。徽标在 ✅ 上换过
  // 词时这里也要跟着换，否则「执行成功」会跟「达成目标」重复印一行。
  final status = airTaskStatus(task);
  final sub = succeededSubLabel(status, task.goalState);
  final badge = sub.isEmpty ? airStatusLabel(status) : sub;
  if (held.isNotEmpty && held != stage && !badge.contains(held)) bits.add(held);
  return bits.join(' · ');
}

/// 行尾那个时间。Web 用的 `toLocaleString('zh-CN', {month, day, hour, minute})`
/// 出来就是 `9/13 14:05`。
///
/// [AirTask.updatedAt] 是毫秒时间戳，不是带偏移的字符串 —— 那种串交给
/// `DateTime.tryParse` 会被当 UTC，这里没这个坑。
String airTaskTime(int updatedAt) {
  if (updatedAt <= 0) return '';
  final at = DateTime.fromMillisecondsSinceEpoch(updatedAt).toLocal();
  String two(int v) => v.toString().padLeft(2, '0');
  return '${at.month}/${at.day} ${two(at.hour)}:${two(at.minute)}';
}
