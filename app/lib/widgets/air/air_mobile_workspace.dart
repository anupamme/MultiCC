import 'package:flutter/material.dart';

import '../../i18n.dart';
import '../../services/air_service.dart';
import '../../theme.dart';
import 'air_panels.dart';
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
    this.setupNotice,
  });
  final AirSnapshot? data;
  final String? directoryId;
  final List<AirTask> recentTasks;
  final ValueChanged<AirTask> onOpenTask;
  final VoidCallback onRecent;
  final Future<void> Function() onRefresh;
  final ValueChanged<String> onResource;
  final bool recent;
  final Widget? setupNotice;

  @override
  State<AirMobileWorkspace> createState() => _AirMobileWorkspaceState();
}

class _AirMobileWorkspaceState extends State<AirMobileWorkspace> {
  String _query = '';
  AirDirectoryTaskFilter _filter = AirDirectoryTaskFilter.all;
  bool _all = false;

  List<AirTask> get _rows {
    final all = widget.data?.tasks ?? <AirTask>[];
    final ids = widget.recentTasks.map((t) => t.id).toSet();
    return [...widget.recentTasks, ...all.where((t) => !ids.contains(t.id))]
        .where(
          (t) => widget.directoryId == null || t.dirId == widget.directoryId,
        )
        .where((t) => _all || t.status != 'archived')
        .toList();
  }

  Widget _task(AirTask task) => AirTaskTile(
    task: task,
    onTap: () => widget.onOpenTask(task),
    showTime: true,
    trailing: widget.data?.isPinned(task.id) == true
        ? const Icon(Icons.push_pin_rounded, size: 16, color: AppColors.accent)
        : null,
    directoryName: widget.data?.directoryOf(task.dirId)?.name ?? '',
  );

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    final urgent = airUrgentTasks(
      widget.data?.tasksOf(widget.directoryId) ?? [],
    );
    final visible = rows
        .where(
          (t) =>
              _filter.matches(t) &&
              t.title.toLowerCase().contains(_query.toLowerCase()),
        )
        .toList();
    return RefreshIndicator(
      onRefresh: widget.onRefresh,
      child: ListView(
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
          const SizedBox(height: 8),
          Text(
            widget.data?.directoryOf(widget.directoryId)?.name ??
                t('airHeaderNoDirectory'),
            style: const TextStyle(color: AppColors.muted),
          ),
          if (widget.recent) ...[
            const SizedBox(height: 18),
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
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final entry in <(String, AirDirectoryTaskFilter, bool)>[
                    (t('airRecentTasks'), AirDirectoryTaskFilter.all, false),
                    (
                      t('airAdminTileWaiting'),
                      AirDirectoryTaskFilter.waiting,
                      true,
                    ),
                    (
                      t('airAdminTileRunning'),
                      AirDirectoryTaskFilter.running,
                      true,
                    ),
                    (
                      t('airAdminTileError'),
                      AirDirectoryTaskFilter.error,
                      true,
                    ),
                    (t('airAdminFilterAll'), AirDirectoryTaskFilter.all, true),
                  ])
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(entry.$1),
                        selected: _filter == entry.$2 && _all == entry.$3,
                        onSelected: (_) => setState(() {
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
            if (visible.isEmpty)
              Padding(
                padding: const EdgeInsets.all(24),
                child: Text(t('airAdminNoMatchingTasks')),
              ),
          ] else ...[
            if (widget.setupNotice != null) widget.setupNotice!,
            const SizedBox(height: 20),
            if (urgent.isNotEmpty)
              Container(
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
                        t('airAdminAttention'),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    ...urgent.take(3).map(_task),
                    if (urgent.length > 3)
                      TextButton(
                        onPressed: widget.onRecent,
                        child: Text(
                          '${t('airAdminFilterAll')} · ${urgent.length}',
                        ),
                      ),
                  ],
                ),
              ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: Text(
                    t('airRecentTasks'),
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                TextButton(
                  onPressed: widget.onRecent,
                  child: Text('${t('airAdminFilterAll')} ›'),
                ),
              ],
            ),
            ...rows.take(3).map(_task),
            if (rows.isEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(t('noRecentTask')),
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
