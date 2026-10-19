part of '../air_tasks_view.dart';

/// 任务行上的手动动作（长按菜单 / 行内按钮）。
///
/// 动作体与搬出来之前逐字一致（乐观更新与失败回滚都在原处）。用 mixin 而不是
/// extension：`setState` 是 protected，只有真正继承 [State] 的子类才能调用；
/// `_data` / `_service` / `_refresh` 这些私有成员由下面的抽象声明接入宿主 State。
mixin _AirTasksViewActions on State<AirTasksView> {
  /// 宿主的 Air 快照（乐观更新在这里读写）。
  AirSnapshot? get _data;
  set _data(AirSnapshot? value);

  AirService get _service;

  Future<void> _refresh();

  /// 长按 / 行内动作：按任务当前状态执行唯一动作（同控制台与目录页）。
  void _runTaskAction(AirTask task) {
    final action = airTaskPrimaryAction(task);
    unawaited(switch (action) {
      AirTaskAction.unignore ||
      AirTaskAction.ignoreError ||
      AirTaskAction.ignoreWaiting => _toggleIgnore(task),
      AirTaskAction.markAchieved => _markAchieved(task),
      AirTaskAction.markTodo || AirTaskAction.unmarkTodo => _toggleTodo(task),
    });
  }

  /// 忽略 / 取消忽略（乐观更新，失败回滚）。
  Future<bool> _toggleIgnore(AirTask task) async {
    final before = _data;
    if (before == null) return false;
    final ignore = !before.isTodoIgnored(task.id);
    final nextIgnored = ignore
        ? {...before.taskTodoIgnored, task.id}.toList()
        : before.taskTodoIgnored.where((id) => id != task.id).toList();
    setState(
      () => _data = before.withTodoLists(
        todos: before.taskTodos,
        ignored: nextIgnored,
      ),
    );
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await _service.toggleTaskTodoIgnore(task.id);
      if (!mounted) return false;
      setState(
        () => _data = _data?.withTodoLists(
          todos: result.todos,
          ignored: result.taskIds,
        ),
      );
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(
              t(ignore ? 'airTodoIgnoredDone' : 'airTodoUnignoredDone'),
            ),
            duration: const Duration(seconds: 2),
          ),
        );
      return true;
    } catch (error) {
      if (!mounted) return false;
      setState(() => _data = before);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(airTaskActionErrorMessage(error))),
        );
      return false;
    }
  }

  /// 标记达成（乐观更新 goalState，失败回滚）。
  Future<bool> _markAchieved(AirTask task) async {
    final before = _data;
    if (before == null) return false;
    setState(
      () => _data = before.withTask(task.copyWith(goalState: 'achieved')),
    );
    final messenger = ScaffoldMessenger.of(context);
    try {
      await _service.markTaskAchieved(task.id);
      if (!mounted) return false;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(t('airTodoMarkAchievedDone')),
            duration: const Duration(seconds: 2),
          ),
        );
      return true;
    } catch (error) {
      if (!mounted) return false;
      setState(() => _data = before);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(airTaskActionErrorMessage(error))),
        );
      return false;
    }
  }

  /// 标记 / 取消手动待办（见 [toggleAirTaskTodo]）。
  Future<bool> _toggleTodo(AirTask task) => toggleAirTaskTodo(
    context: context,
    service: _service,
    task: task,
    onChanged: _refresh,
  );
}
