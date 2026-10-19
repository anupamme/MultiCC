part of '../air_tasks_view.dart';

extension _AirTasksViewSync on _AirTasksViewState {
  void _syncChanged() {
    final result = _sync.snapshot;
    if (!mounted || result == null) return;
    _updateMobile(() {
      _data = result;
      if (!_capacityError && _sync.status != 'offline') _error = '';
      if (result.directoryOf(_directoryId) == null) {
        _directoryId = result.directories.firstOrNull?.id;
      }
    });
  }

  AirPageResult? get _directoryPage => _sync.page('directory', {
    'dirId': _directoryId,
    'status': _taskQuery.trim().isNotEmpty ? 'all' : _taskStatus.apiValue,
    'query': _directorySearch.ids != null ? '' : _taskQuery.trim(),
    if (_directorySearch.ids != null) 'ids': _directorySearch.ids!.join(','),
    'page': _tasksPage,
    'sort': _taskSort.name,
    'visits': _store?.taskVisitedAt ?? const <String, int>{},
  });

  /// The header count covers the whole directory, including unloaded rows.
  Future<void> _showRunningTasks() async {
    final data = _data, dirId = _directoryId;
    if (data == null || dirId == null) return;
    if ((data.count('running', dirId) ??
            data.tasksOf(dirId).where(airTaskRunning).length) ==
        0) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('本目录当前没有正在执行的任务。')));
      return;
    }
    var pageNumber = 1;
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.panel,
      showDragHandle: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (_, update) => ListenableBuilder(
          listenable: _sync,
          builder: (_, _) {
            final current = _sync.snapshot ?? data;
            final remote = _sync.page('running-sheet', {
              'dirId': dirId,
              'status': 'running',
              'page': pageNumber,
            });
            final running = current.indexed
                ? [
                    for (final id in remote?.ids ?? const <String>[])
                      if (current.taskOf(id) case final task?) task,
                  ]
                : current.tasksOf(dirId).where(airTaskRunning).toList();
            final total = current.count('running', dirId) ?? running.length;
            return SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '正在执行 $total 个任务',
                      style: const TextStyle(
                        color: AppColors.text,
                        fontSize: 14.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 10),
                    if (current.indexed && remote == null)
                      const LinearProgressIndicator(),
                    Flexible(
                      child: ListView(
                        shrinkWrap: true,
                        children: [
                          for (final task in running)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: AirTaskTile(
                                task: task,
                                showTime: true,
                                onTap: () {
                                  Navigator.of(sheetContext).pop();
                                  unawaited(_open(task));
                                },
                                onLongPress: () => _runTaskAction(task),
                              ),
                            ),
                        ],
                      ),
                    ),
                    if ((remote?.pages ?? 1) > 1)
                      AirTaskPagerBar(
                        page: remote!.page,
                        pageCount: remote.pages,
                        keyPrefix: 'air-running',
                        onPage: (value) => update(() => pageNumber = value),
                      ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  Future<void> _refreshAir() async {
    if (_loading) return;
    _loading = true;
    try {
      final result = await _sync.refresh();
      if (!mounted) return;
      _updateMobile(() {
        _data = result;
        if (!_capacityError) _error = '';
        if (result.directoryOf(_directoryId) == null) {
          _directoryId = result.directories.isEmpty
              ? null
              : result.directories.first.id;
        }
      });
      // 收藏和最近记录指向的目录/任务可能已经被删掉，顺手清一遍，免得侧栏留着
      // 一个点不开的名字。
      if (!result.indexed) {
        await _store?.prune(
          directoryIds: result.directories.map((d) => d.id).toSet(),
          taskIds: result.tasks.map((t) => t.id).toSet(),
        );
      }
      if (mounted) _updateMobile(() {});
      if (result.indexed && (_store?.recentTasks.isNotEmpty ?? false)) {
        _sync.page('include', {
          'status': 'all',
          'ids': (_store?.recentTasks ?? const []).take(50).join(','),
          'limit': 50,
        });
      }
      // 引导等数据到位再开始：早一步锚点还不存在，会走成「找不到目标就往下跳」。
      _maybeStartTour();
    } catch (error) {
      if (mounted) _updateMobile(() => _error = error.toString());
    } finally {
      _loading = false;
    }
  }
}
