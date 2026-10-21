import 'package:flutter/material.dart';

import '../../i18n.dart';
import '../../services/air_service.dart';
import '../../services/air_sync_service.dart';
import '../../theme.dart';
import 'air_panels.dart';
import 'air_task_status.dart';

/// 手机控制台：上段「等我处理」限条，下段是一份不限条数的任务清单（搜索 + 状态格 +
/// 服务端分页、滚到底自动接下一页）。原来的「最近任务」整页并进了这里 —— 控制台、
/// 最近任务、项目三个入口在手机上功能重叠，用户拍板合成一个（同 Web `air-mobile.js`）。
class AirMobileWorkspace extends StatefulWidget {
  const AirMobileWorkspace({
    super.key,
    required this.data,
    required this.directoryId,
    required this.recentTasks,
    required this.onOpenTask,
    required this.onRefresh,
    required this.onResource,
    this.sync,
    this.setupNotice,
    this.onTaskAction,
  });
  final AirSnapshot? data;
  final AirSyncService? sync;

  /// 本页按哪个项目看（null = 全部项目）；由顶栏的项目选择决定。
  final String? directoryId;
  final List<AirTask> recentTasks;
  final ValueChanged<AirTask> onOpenTask;
  final Future<void> Function() onRefresh;
  final ValueChanged<String> onResource;
  final Widget? setupNotice;

  /// 长按任务行：执行这条任务当前状态的唯一动作（见 [airTaskPrimaryAction]）。
  final ValueChanged<AirTask>? onTaskAction;

  @override
  State<AirMobileWorkspace> createState() => _AirMobileWorkspaceState();
}

class _AirMobileWorkspaceState extends State<AirMobileWorkspace> {
  /// 服务端单页上限就是 50（`air-read-index.js` 的 page()），取满，少发几次请求。
  static const _pageSize = 50;

  /// 只有前几页随快照实时重读；更深的页读到一次就冻结成员（任务本身的状态仍从
  /// 快照取，是活的）。AirSyncService 的页缓存只有 16 格，全部页都实时重读的话，
  /// 翻得深了会互相挤出缓存、来回重拉。
  static const _livePages = 4;

  /// 离底部还剩多少像素就去接下一页。
  static const _loadAhead = 600.0;

  String _query = '';
  final _scroll = ScrollController();
  final _listHead = GlobalKey();

  /// 下段清单当前那一格。`_all` 区分同为 [AirDirectoryTaskFilter.all] 的两格：
  /// false =「最近任务」（不含归档，服务端 status=recent），true =「全部记录」。
  AirDirectoryTaskFilter _filter = AirDirectoryTaskFilter.all;
  bool _all = false;

  /// 已经要了几页、每页读回来的结果。换筛选 / 搜索 / 项目（[_listKey] 变了）就从
  /// 第一页重来。保留读回来的旧结果，是为了某一页被挤出缓存或正在重读时不闪空。
  int _pages = 1;
  final _loaded = <int, AirPageResult>{};
  String? _listKey;

  /// 服务端说一共几页；本地快照模式下为 1（整份都在手里，不分页）。
  int _pageCount = 1;

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

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadMore);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _select(AirDirectoryTaskFilter filter, bool all) => setState(() {
    _filter = filter;
    _all = all;
  });

  /// 滚到离底部不足 [_loadAhead] 时接下一页。只有最后要的那一页已经回来才接，
  /// 否则一次滚动会连发好几页；内容不满一屏时由 build 后的那一帧补触发。
  void _maybeLoadMore() {
    if (!mounted || !_scroll.hasClients) return;
    if (_pages >= _pageCount || !_loaded.containsKey(_pages)) return;
    final position = _scroll.position;
    if (position.maxScrollExtent - position.pixels > _loadAhead) return;
    setState(() => _pages++);
  }

  /// 卡片「全部 ›」：不再跳页，把下段清单切到「等我处理」并滚过去。
  void _showNeedsMe() {
    _select(AirDirectoryTaskFilter.needsMe, true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final head = _listHead.currentContext;
      if (head != null && head.mounted) {
        Scrollable.ensureVisible(head, duration: kThemeAnimationDuration);
      }
    });
  }

  /// 本地快照（旧服务、无索引）下的清单：pin 住的排最前，其余按最后活动时间倒序
  /// （同 Web `air-mobile.js` 的 recentRows）。不沿用侧栏「本机打开过」的顺序——
  /// 在别的端新建、这台手机没点开过的任务会被挤到底，而快照里的 tasks 本身是从旧
  /// 到新排的。整份都在手里，不截断。
  List<AirTask> _localRows() {
    final data = widget.data;
    final all = (data?.tasks ?? <AirTask>[])
        .where(
          (t) => widget.directoryId == null || t.dirId == widget.directoryId,
        )
        .where((t) => _all || t.status != 'archived')
        .toList();
    final byId = {for (final task in all) task.id: task};
    final pinned = [
      for (final id in data?.taskPins ?? const <String>[])
        if (byId[id] != null) byId[id]!,
    ];
    final ids = pinned.map((t) => t.id).toSet();
    int activeAt(AirTask t) =>
        t.lastMessageAt > 0 ? t.lastMessageAt : t.updatedAt;
    final rest = all.where((t) => !ids.contains(t.id)).toList()
      ..sort((a, b) => activeAt(b).compareTo(activeAt(a)));
    final query = _query.toLowerCase();
    return [...pinned, ...rest]
        .where(
          (t) => _filter.matches(t) && t.title.toLowerCase().contains(query),
        )
        .toList();
  }

  /// 索引模式下的清单：第 1.._pages 页按顺序拼起来。页与页之间可能因为新任务插到
  /// 顶上而错位一两条，按 id 去重即可（只会重复，不会漏 —— 新任务往前挤）。
  List<AirTask> _remoteRows(AirSyncService sync) {
    final status = !_all && _filter == AirDirectoryTaskFilter.all
        ? 'recent'
        : _filter.apiValue;
    final query = _query.trim();
    final key = '${widget.directoryId}\u0000$status\u0000$query';
    if (key != _listKey) {
      _listKey = key;
      _loaded.clear();
      _pages = 1;
      _pageCount = 1;
    }
    for (var p = 1; p <= _pages; p++) {
      if (p > _livePages && _loaded.containsKey(p)) continue;
      final result = sync.page('mobile-list-$p', {
        'dirId': widget.directoryId,
        'status': status,
        'query': query,
        'limit': _pageSize,
        'page': p,
      });
      if (result != null) _loaded[p] = result;
    }
    final head = _loaded[1] ?? _loaded[_pages];
    if (head != null) _pageCount = head.pages;
    final seen = <String>{};
    return [
      for (var p = 1; p <= _pages; p++)
        for (final id in _loaded[p]?.ids ?? const <String>[])
          if (seen.add(id))
            if (widget.data?.taskOf(id) case final task?) task,
    ];
  }

  Widget _task(AirTask task) => AirTaskTile(
    key: ValueKey('air-mobile-row-${task.id}'),
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
    // directoryId 为 null（全部项目）时看所有项目。
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
    final sync = widget.sync;
    final indexed = widget.data?.indexed == true && sync != null;
    final counts = widget.data?.taskStats[widget.directoryId ?? 'all'];
    final needsPage = sync?.page('mobile-needs', {
      'dirId': widget.directoryId,
      'status': 'needs',
      'limit': 3,
    });
    final needsMe = indexed ? rowsOf(needsPage) : airNeedsMeTasks(scoped);
    final needsCount = counts?['needs'] ?? needsMe.length;
    if (!indexed) _pageCount = 1;
    final visible = indexed ? _remoteRows(sync) : _localRows();
    final loadingFirst = indexed && _loaded.isEmpty;
    final loadingMore =
        indexed && !loadingFirst && !_loaded.containsKey(_pages);
    final hasMore = indexed && _pages < _pageCount;
    // 内容不满一屏时没有滚动事件可等，这一帧画完再看一眼要不要接下一页。
    if (hasMore) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _maybeLoadMore());
    }
    // 每一格的数量走服务端统计（taskStats）；旧服务没有统计时按本地快照数。
    int countOf(AirDirectoryTaskFilter filter, bool all) {
      if (counts != null) {
        final total = counts['total'] ?? 0;
        if (filter == AirDirectoryTaskFilter.all) {
          return all ? total : total - (counts['archived'] ?? 0);
        }
        return counts[filter.countKey] ?? 0;
      }
      return scoped
          .where((t) => all || t.status != 'archived')
          .where(filter.matches)
          .length;
    }

    final chips = <(String, String, AirDirectoryTaskFilter, bool)>[
      ('recent', 'airRecentTasks', AirDirectoryTaskFilter.all, false),
      for (final (filter, key) in _statusFilters)
        (filter.name, key, filter, true),
      ('all', 'airAdminFilterAll', AirDirectoryTaskFilter.all, true),
    ];
    return RefreshIndicator(
      onRefresh: widget.onRefresh,
      child: ListView(
        controller: _scroll,
        key: const PageStorageKey('mobile-console-scroll'),
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 20),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          Text(
            t('airConsole'),
            style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Text(
            widget.data?.directoryOf(widget.directoryId)?.name ??
                t('airAllProjects'),
            style: const TextStyle(color: AppColors.muted),
          ),
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
                      // 把下段清单切到「等我处理」这一格：数量、清单和点开的是
                      // 同一份清单，不会显示成「全部任务」。
                      onPressed: _showNeedsMe,
                      child: Text('${t('airAdminFilterAll')} · $needsCount'),
                    ),
                ],
              ),
            ),
          // 资料入口放在清单上面：下段不限条数、滚到底会一直接下一页，放在末尾
          // 就永远够不着。
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
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('air-mobile-task-search'),
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              hintText: t('airAdminSearchTasksLabel'),
              filled: true,
            ),
            onChanged: (v) => setState(() => _query = v),
          ),
          const SizedBox(height: 12),
          // 桌面那排统计格在手机上放不下，这里换成一行带数量的小格。
          SingleChildScrollView(
            key: _listHead,
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final (id, key, filter, all) in chips)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      key: ValueKey('air-mobile-filter-$id'),
                      label: Text('${t(key)} ${countOf(filter, all)}'),
                      selected: _filter == filter && _all == all,
                      onSelected: (_) => _select(filter, all),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          ...visible.map(_task),
          if (loadingFirst)
            const LinearProgressIndicator()
          else if (visible.isEmpty)
            Padding(
              padding: const EdgeInsets.all(24),
              child: Text(t('airAdminNoMatchingTasks')),
            ),
          if (loadingMore || hasMore)
            const Padding(
              key: ValueKey('air-mobile-list-more'),
              padding: EdgeInsets.all(16),
              child: Center(
                child: SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
