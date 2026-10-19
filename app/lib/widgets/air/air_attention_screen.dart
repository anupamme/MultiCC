import 'package:flutter/material.dart';

import '../../i18n.dart';
import '../../services/air_service.dart';
import '../../services/air_sync_service.dart';
import '../../theme.dart';
import 'air_panels.dart';
import 'air_directory_task_panel.dart';

/// 「等我处理」的整页。
///
/// 控制台那一格只放最近更新的几条，完整清单在这里。对应 Web `public/air-admin.js`
/// 的 `renderAttention`（`?view=attention`）：同一份清单、同一个顺序、同一句总数。
///
/// 新服务通过共享同步按需分页；旧服务使用调用方按 `airNeedsMeTasks` 取好的清单。
/// 两种方式与控制台使用相同的待处理口径。
class AirAttentionScreen extends StatefulWidget {
  const AirAttentionScreen({
    super.key,
    required this.tasks,
    required this.directoryName,
    required this.onOpenTask,
    this.onTaskAction,
    this.sync,
  });

  /// 已经按「最早的消息在前」排好的完整清单（`airNeedsMeTasks` 的返回值）。
  final List<AirTask> tasks;
  final AirSyncService? sync;

  /// 跨目录的清单要把「它在哪个目录」写在行上。
  final String Function(String dirId) directoryName;

  /// 点开一条任务。这一页只是清单，点走之后由宿主持平后面那层控制台。
  final ValueChanged<AirTask> onOpenTask;

  /// 长按任务行 / 行内动作：执行这条任务当前状态的唯一动作（见
  /// [airTaskPrimaryAction]）。
  final ValueChanged<AirTask>? onTaskAction;

  @override
  State<AirAttentionScreen> createState() => _AirAttentionScreenState();
}

class _AirAttentionScreenState extends State<AirAttentionScreen> {
  int _page = 1;
  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void initState() {
    super.initState();
    widget.sync?.addListener(_changed);
  }

  @override
  void dispose() {
    widget.sync?.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final remote = widget.sync?.page('attention', {
      'status': 'needs',
      'page': _page,
    });
    final indexed = widget.sync?.indexed == true;
    final tasks = indexed
        ? [
            for (final id in remote?.ids ?? const <String>[])
              if (widget.sync!.snapshot?.taskOf(id) case final task?) task,
          ]
        : widget.tasks;
    final total =
        remote?.total ??
        (indexed ? widget.sync!.snapshot?.count('needs') ?? 0 : tasks.length);
    return Scaffold(
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        backgroundColor: AppColors.panel,
        foregroundColor: AppColors.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          t('airAdminAttention'),
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      body: ListView(
        key: const ValueKey('air-attention'),
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
        children: [
          Container(
            decoration: BoxDecoration(
              color: AppColors.panel,
              borderRadius: BorderRadius.circular(AppColors.radiusPanel),
              border: Border.all(color: AppColors.line),
            ),
            padding: const EdgeInsets.fromLTRB(13, 12, 13, 13),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Text(
                            'ACROSS ALL WORKSPACES',
                            style: TextStyle(
                              color: AppColors.faint,
                              fontSize: 9.5,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 1.1,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            t('airAdminAttention'),
                            style: const TextStyle(
                              color: AppColors.text,
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(left: 8, top: 12),
                      child: Text(
                        total == 0 ? '当前没有要处理的事' : '$total 条 · 按最早消息排序，点击直达',
                        style: const TextStyle(
                          color: AppColors.faint,
                          fontSize: 10.5,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                for (final task in tasks)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: AirTaskTile(
                      // 同一条任务在控制台那一格和这一页里各出现一次，两处各给
                      // 一份自己的标识，免得同一棵树里撞 key。
                      key: ValueKey('air-attention-task-${task.id}'),
                      task: task,
                      directoryName: widget.directoryName(task.dirId),
                      showTime: true,
                      onTap: () => widget.onOpenTask(task),
                      onLongPress: widget.onTaskAction == null
                          ? null
                          : () => widget.onTaskAction!(task),
                    ),
                  ),
                if (indexed && remote == null)
                  const LinearProgressIndicator()
                else if (tasks.isEmpty)
                  const _Empty('没有正在等我的任务。'),
                if ((remote?.pages ?? 1) > 1)
                  AirTaskPagerBar(
                    page: remote!.page,
                    pageCount: remote.pages,
                    onPage: (page) => setState(() => _page = page),
                    keyPrefix: 'air-attention',
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 22),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
    ),
  );
}
