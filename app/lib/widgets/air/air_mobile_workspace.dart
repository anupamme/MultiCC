import 'package:flutter/material.dart';

import '../../i18n.dart';
import '../../services/air_service.dart';
import '../../services/air_sync_service.dart';
import '../../theme.dart';
import 'air_panels.dart';
import 'air_directory_task_panel.dart';
import 'air_task_status.dart';

/// 手机控制台和最近任务共用真实快照与状态判定；切换页面不重建会话。
class AirMobileWorkspace extends StatefulWidget {
  const AirMobileWorkspace({
    super.key,
    required this.data,
    required this.directoryId,
    required this.recentTasks,
    required this.onOpenTask,
    required this.onRecent,
    required this.onRefresh,
    required this.onResource,
    this.recent = false,
    this.sync,
    this.initialFilter,
    this.setupNotice,
    this.onTaskAction,
  });
  final AirSnapshot? data;
  final AirSyncService? sync;
  final String? directoryId;
  final List<AirTask> recentTasks;
  final ValueChanged<AirTask> onOpenTask;

  /// 进「最近任务」页；带上控制台卡片当前那一格（null = 最近任务）。
  final ValueChanged<AirDirectoryTaskFilter?> onRecent;
  final Future<void> Function() onRefresh;
  final ValueChanged<String> onResource;
  final bool recent;

  /// 最近任务页一打开就选中的那一格（从控制台卡片的「全部 ›」带过来）。
  final AirDirectoryTaskFilter? initialFilter;
  final Widget? setupNotice;

  /// 长按任务行：执行这条任务当前状态的唯一动作（见 [airTaskPrimaryAction]）。
  final ValueChanged<AirTask>? onTaskAction;

  @override
  State<AirMobileWorkspace> createState() => _AirMobileWorkspaceState();
}

class _AirMobileWorkspaceState extends State<AirMobileWorkspace> {
  String _query = '';
  int _page = 1;
  final _scroll = ScrollController();

  void _changePage(int page) {
    if (_scroll.hasClients) _scroll.jumpTo(0);
    setState(() => _page = page);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant AirMobileWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.directoryId != widget.directoryId) _page = 1;
  }

  late AirDirectoryTaskFilter _filter =
      widget.initialFilter ?? AirDirectoryTaskFilter.all;
  late bool _all = widget.initialFilter != null;

  /// 控制台卡片当前那一格；null = 最近任务（同 Web `air-mobile.js` 的 consoleView）。
  AirDirectoryTaskFilter? _consoleFilter;

  /// 状态格：「等我处理」打头（等待输入、出错、需要交互和手动标记的都在这一格，
  /// 见 airTaskNeedsMe），「待办」只收手动标记，「今日完成」紧随其后，手机宽度
  /// 不用横滑就能点到（同 Web MOBILE_FILTERS）。判定都走
  /// [AirDirectoryTaskFilter.matches]，与目录首页、桌面控制台同口径。
  static const _statusFilters = [
    (AirDirectoryTaskFilter.needsMe, 'airNeedsMeFilter'),
    (AirDirectoryTaskFilter.todo, 'airTodoFilter'),
    (AirDirectoryTaskFilter.today, 'airAdminTileToday'),
    (AirDirectoryTaskFilter.running, 'airAdminTileRunning'),
    (AirDirectoryTaskFilter.error, 'airAdminTileError'),
  ];

  /// 手机「最近任务」：pin 住的排最前，其余按最后活动时间倒序（同 Web
  /// `air-mobile.js` 的 recentRows）。不沿用侧栏「本机打开过」的顺序——在别的端
  /// 新建、这台手机没点开过的任务会被挤到底，而快照里的 tasks 本身是从旧到新排的。
  List<AirTask> get _rows => _rowsOf(withPins: true);

  /// 控制台那张卡只摆 3 条，不带 pin（pin 多了会把它整张占满），按「等我处理」
  /// 口径取等我最久的那几条（见 [airNeedsMeTasks]）。
  List<AirTask> _rowsOf({required bool withPins}) {
    final data = widget.data;
    final all = (data?.tasks ?? <AirTask>[])
        .where(
          (t) => widget.directoryId == null || t.dirId == widget.directoryId,
        )
        .where((t) => _all || t.status != 'archived')
        .toList();
    final byId = {for (final task in all) task.id: task};
    final pinned = [
      for (final id
          in withPins ? data?.taskPins ?? const <String>[] : const <String>[])
        if (byId[id] != null) byId[id]!,
    ];
    final ids = pinned.map((t) => t.id).toSet();
    int activeAt(AirTask t) =>
        t.lastMessageAt > 0 ? t.lastMessageAt : t.updatedAt;
    final rest = all.where((t) => !ids.contains(t.id)).toList()
      ..sort((a, b) => activeAt(b).compareTo(activeAt(a)));
    return [...pinned, ...rest];
  }

  Widget _task(AirTask task) => AirTaskTile(
    task: task,
    onTap: () => widget.onOpenTask(task),
    onLongPress: widget.onTaskAction == null
        ? null
        : () => widget.onTaskAction!(task),
    showTime: true,
    trailing: widget.data?.isPinned(task.id) == true
        ? const Icon(Icons.push_pin_rounded, size: 16, color: AppColors.accent)
        : null,
    directoryName: widget.data?.directoryOf(task.dirId)?.name ?? '',
  );

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    // directoryId 为 null（控制台、最近任务的「全部项目」）时看所有项目。
    final scoped = (widget.data?.tasks ?? <AirTask>[])
        .where(
          (t) => widget.directoryId == null || t.dirId == widget.directoryId,
        )
        .toList();
    // 与控制台「等我处理」同一份口径：等回答 / 出错 / 需要交互 / 手动标记，
    // 排除归档与被忽略，最早的消息在前。
    List<AirTask> rowsOf(AirPageResult? page) => [
      for (final id in page?.ids ?? const <String>[])
        if (widget.data?.taskOf(id) case final task?) task,
    ];
    final indexed = widget.data?.indexed == true;
    final counts = widget.data?.taskStats[widget.directoryId ?? 'all'];
    final needsPage = widget.sync?.page('mobile-needs', {
      'dirId': widget.directoryId,
      'status': 'needs',
      'limit': 3,
    });
    final needsMe = indexed ? rowsOf(needsPage) : airNeedsMeTasks(scoped);
    final needsCount = counts?['needs'] ?? needsMe.length;
    final recentAll = _rowsOf(withPins: false);
    final consolePage = widget.sync?.page('mobile-console', {
      'dirId': widget.directoryId,
      'status': _consoleFilter?.apiValue ?? 'recent',
      'limit': _consoleFilter == null ? 3 : 5,
    });
    final consoleRows = indexed
        ? rowsOf(consolePage)
        : _consoleFilter == null
        ? recentAll
        : recentAll.where(_consoleFilter!.matches).toList();
    final remote = widget.recent
        ? widget.sync?.page('mobile-recent', {
            'dirId': widget.directoryId,
            'status': !_all && _filter == AirDirectoryTaskFilter.all
                ? 'recent'
                : _filter.apiValue,
            'query': _query.trim(),
            'page': _page,
          })
        : null;
    final visible = indexed
        ? rowsOf(remote)
        : rows
              .where(
                (t) =>
                    _filter.matches(t) &&
                    t.title.toLowerCase().contains(_query.toLowerCase()),
              )
              .toList();
    return RefreshIndicator(
      onRefresh: widget.onRefresh,
      child: ListView(
        controller: _scroll,
        key: PageStorageKey(
          widget.recent ? 'mobile-recent-scroll' : 'mobile-console-scroll',
        ),
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 20),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          Text(
            widget.recent ? t('airRecentTasks') : t('airConsole'),
            style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
          ),
          if (widget.recent) ...[
            const SizedBox(height: 8),
            Text(
              widget.data?.directoryOf(widget.directoryId)?.name ??
                  t('airAllProjects'),
              style: const TextStyle(color: AppColors.muted),
            ),
          ],
          if (widget.recent) ...[
            const SizedBox(height: 18),
            TextField(
              key: const ValueKey('air-mobile-task-search'),
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: t('airAdminSearchTasksLabel'),
                filled: true,
              ),
              onChanged: (v) => setState(() {
                _query = v;
                _page = 1;
              }),
            ),
            const SizedBox(height: 12),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final entry in <(String, AirDirectoryTaskFilter, bool)>[
                    (t('airRecentTasks'), AirDirectoryTaskFilter.all, false),
                    for (final (filter, key) in _statusFilters)
                      (t(key), filter, true),
                    (t('airAdminFilterAll'), AirDirectoryTaskFilter.all, true),
                  ])
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(entry.$1),
                        selected: _filter == entry.$2 && _all == entry.$3,
                        onSelected: (_) => setState(() {
                          _page = 1;
                          _filter = entry.$2;
                          _all = entry.$3;
                        }),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            ...visible.map(_task),
            if (indexed && remote == null)
              const LinearProgressIndicator()
            else if (visible.isEmpty)
              Padding(
                padding: const EdgeInsets.all(24),
                child: Text(t('airAdminNoMatchingTasks')),
              ),
            if ((remote?.pages ?? 1) > 1)
              AirTaskPagerBar(
                page: remote!.page,
                pageCount: remote.pages,
                keyPrefix: 'air-mobile-recent',
                onPage: _changePage,
              ),
          ] else ...[
            if (widget.setupNotice != null) widget.setupNotice!,
            const SizedBox(height: 20),
            if (needsCount > 0)
              Container(
                key: const ValueKey('air-mobile-todo-card'),
                decoration: BoxDecoration(
                  color: AppColors.panel,
                  border: Border.all(color: AppColors.line),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.all(14),
                      child: Text(
                        t('airNeedsMeFilter'),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    ...needsMe.take(3).map(_task),
                    if (needsCount > 3)
                      TextButton(
                        key: const ValueKey('air-mobile-todo-all'),
                        // 带着「等我处理」这一格进最近任务页：数量、清单和点开
                        // 的是同一份清单，不会显示成「全部任务」。
                        onPressed: () =>
                            widget.onRecent(AirDirectoryTaskFilter.needsMe),
                        child: Text('${t('airAdminFilterAll')} · $needsCount'),
                      ),
                  ],
                ),
              ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: Text(
                    _consoleFilter == null
                        ? t('airRecentTasks')
                        : t(
                            _statusFilters
                                .firstWhere((f) => f.$1 == _consoleFilter)
                                .$2,
                          ),
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                TextButton(
                  key: const ValueKey('air-mobile-console-all'),
                  onPressed: () => widget.onRecent(_consoleFilter),
                  child: Text(
                    '${t('airAdminFilterAll')} ${consolePage?.total ?? consoleRows.length} ›',
                  ),
                ),
              ],
            ),
            // 桌面那排统计格在手机上放不下，这里换成一行带数量的小格。
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final (filter, key) in [
                    (null, 'airRecentTasks'),
                    ..._statusFilters,
                  ])
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        key: ValueKey(
                          'air-mobile-console-${filter?.name ?? 'recent'}',
                        ),
                        label: Text(
                          filter == null
                              ? t(key)
                              : '${t(key)} ${counts?[filter.countKey] ?? recentAll.where(filter.matches).length}',
                        ),
                        selected: _consoleFilter == filter,
                        onSelected: (_) =>
                            setState(() => _consoleFilter = filter),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            // 「最近」只摆 3 条，按状态看时多给两条，免得今天完成的刚好被截掉一半。
            ...consoleRows.take(_consoleFilter == null ? 3 : 5).map(_task),
            if (consoleRows.isEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  _consoleFilter == null
                      ? t('noRecentTask')
                      : t('airAdminNoMatchingTasks'),
                ),
              ),
            const SizedBox(height: 12),
            ExpansionTile(
              key: const PageStorageKey('mobile-resources'),
              tilePadding: EdgeInsets.zero,
              title: const Text('项目资料', style: TextStyle(fontSize: 14)),
              children: [
                for (final item in [
                  ('docs', t('airDocs')),
                  ('memory', t('airMemoryGraph')),
                  ('taskgraph', t('airTaskGraph')),
                ])
                  ListTile(
                    title: Text(item.$2),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => widget.onResource(item.$1),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
