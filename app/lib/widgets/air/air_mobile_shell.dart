part of '../air_tasks_view.dart';

/// 只负责触屏壳；数据、任务打开、创建和连接都沿用宿主。
extension _AirMobileShell on _AirTasksViewState {
  String get _mobileTitle => switch (_mode) {
    _AirMode.console => '控制台',
    _AirMode.recent => '最近任务',
    _AirMode.schedules => '定时任务',
    _AirMode.library => '工作目录',
    _AirMode.tasks => _data?.directoryOf(_directoryId)?.name ?? '工作目录',
  };

  Future<void> _mobileSettings() async {
    await widget.beforeOpenNavigation?.call();
    if (!mounted) return;
    _closeDrawer();
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AirSettingsScreen(
          settings: widget.settings,
          ops: _ops,
          clientVersion: _clientVersion,
          returnLabel: _mobileTitle,
          onSwitchServer: widget.onSwitchServer,
          onVoiceCall: widget.onOpenVoiceCall,
          onOnboarding: () {
            Navigator.of(context).popUntil((route) => route.isFirst);
            unawaited(_tourKey.currentState?.restart() ?? Future.value());
          },
          onLogout: () => unawaited(
            confirmAirLogout(
              context,
              onLogout: () async {
                await _ops.logout();
                if (!mounted) return;
                unawaited(
                  Navigator.of(context).pushAndRemoveUntil(
                    MaterialPageRoute<void>(
                      builder: (_) => SetupScreen(settings: widget.settings),
                    ),
                    (_) => false,
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
    if (mounted) await _mobileSetup.currentState?.refresh();
  }

  /// [recentFilter]：在「最近任务」页里打开时，这张面板是那一页的目录筛选 ——
  /// 多一行「全部项目」，选完留在原页，不跳去目录首页（同 Web air-mobile.js）。
  Future<void> _mobileProjects({bool recentFilter = false}) async {
    final current = recentFilter ? _mobileRecentDir : _directoryId;
    await widget.beforeOpenNavigation?.call();
    if (!mounted) return;
    final chosen = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (sheetContext) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: .55,
        minChildSize: .3,
        maxChildSize: .9,
        builder: (_, scroll) => ListView(
          controller: scroll,
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              '切换项目',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            if (recentFilter)
              ListTile(
                key: const ValueKey('air-mobile-project-all'),
                leading: const Icon(Icons.folder_copy_outlined),
                title: Text(t('airAllProjects')),
                trailing: current == null ? const Icon(Icons.check) : null,
                onTap: () => Navigator.pop(sheetContext, '__all__'),
              ),
            for (final directory in _data?.directories ?? <AirDirectory>[])
              ListTile(
                key: ValueKey('air-mobile-project-${directory.id}'),
                leading: const Icon(Icons.folder_outlined),
                title: Text(directory.name),
                subtitle: Text(
                  directory.path,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: directory.id == current
                    ? const Icon(Icons.check)
                    : null,
                onTap: () => Navigator.pop(sheetContext, directory.id),
              ),
            const Divider(),
            ListTile(
              leading: const Icon(Icons.folder_open),
              title: const Text('管理工作目录'),
              onTap: () => Navigator.pop(sheetContext, '__library__'),
            ),
            ListTile(
              leading: const Icon(Icons.create_new_folder_outlined),
              title: const Text('添加工作目录'),
              onTap: () => Navigator.pop(sheetContext, '__create__'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || chosen == null) return;
    if (chosen == '__library__') {
      _updateMobile(() => _mode = _AirMode.library);
      return;
    }
    if (chosen == '__create__') {
      await _addDirectory();
      return;
    }
    if (recentFilter) {
      _updateMobile(
        () => _mobileRecentDir = chosen == '__all__' ? null : chosen,
      );
      return;
    }
    final previous = _mode;
    _selectDirectory(chosen);
    _updateMobile(
      () => _mode = previous == _AirMode.library ? _AirMode.console : previous,
    );
  }

  Widget _mobileWorkspace(AirSnapshot? data) => AirMobileWorkspace(
    key: ValueKey(_mode),
    data: data,
    // 控制台跨所有项目；最近任务按本页选的目录（null = 全部项目）。
    directoryId: _mode == _AirMode.recent ? _mobileRecentDir : null,
    recent: _mode == _AirMode.recent,
    initialFilter: _mode == _AirMode.recent ? _mobileRecentFilter : null,
    recentTasks: _sidebarTasks(),
    setupNotice: data == null
        ? null
        : AirMobileSetup(
            key: _mobileSetup,
            settings: widget.settings,
            httpClient: widget.httpClient,
            onSettings: _mobileSettings,
          ),
    onOpenTask: (task) => unawaited(_open(task)),
    onRefresh: _refresh,
    onRecent: (filter) => _updateMobile(() {
      _mobileRecentFilter = filter;
      _mode = _AirMode.recent;
    }),
    onResource: (v) {
      switch (v) {
        case 'docs':
          unawaited(
            _push(
              (_) => DocsRegistryScreen(
                settings: widget.settings,
                httpClient: widget.httpClient,
              ),
            ),
          );
        case 'memory':
          _openMemoryGraph();
        case 'taskgraph':
          unawaited(_openTaskGraph());
      }
    },
  );

  Widget _mobileSchedulePanel(AirSnapshot? data) => Column(
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
        child: AirScheduleTabs(
          hooks: _mobileHooksTab,
          onChanged: (value) => _updateMobile(() => _mobileHooksTab = value),
        ),
      ),
      Expanded(
        child: _mobileHooksTab
            ? HookListView(key: _mobileHooks, settings: widget.settings)
            : AirSchedulePanel(
                key: _mobileSchedules,
                settings: widget.settings,
                httpClient: widget.httpClient,
                directories: data?.directories ?? [],
                initialDirectoryId: _directoryId,
                directoryId: _directoryId,
                onOpenTask: _openTaskById,
                padding: const EdgeInsets.all(16),
              ),
      ),
    ],
  );

  Widget _mobileScaffold(
    AirSnapshot? data,
    AirDirectory? directory,
    List<AirTask> tasks,
    Set<String> runningDirectories,
  ) {
    final schedules = _mode == _AirMode.schedules;
    return Scaffold(
      key: _scaffoldKey,
      backgroundColor: AppColors.bg,
      appBar: AppBar(
        automaticallyImplyLeading: false,
        titleSpacing: 12,
        // 控制台不分目录：顶栏只留服务器地址，不给目录按钮。最近任务里这个按钮是
        // 本页的目录筛选；其余页面照旧是切换当前项目。
        title: InkWell(
          key: const ValueKey('air-mobile-project-picker'),
          onTap: _mode == _AirMode.console
              ? null
              : () => unawaited(
                  _mobileProjects(recentFilter: _mode == _AirMode.recent),
                ),
          child: Row(
            children: [
              if (_mode != _AirMode.console) ...[
                const Icon(Icons.folder_outlined, color: AppColors.accent),
                const SizedBox(width: 8),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_mode != _AirMode.console)
                      Text(
                        _mode == _AirMode.recent
                            ? data?.directoryOf(_mobileRecentDir)?.name ??
                                  t('airAllProjects')
                            : directory?.name ?? '选择项目',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    Text(
                      widget.settings.host,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 10,
                        color: AppColors.muted,
                      ),
                    ),
                  ],
                ),
              ),
              if (_mode != _AirMode.console)
                const Icon(Icons.expand_more, size: 18),
            ],
          ),
        ),
        actions: [
          IconButton(
            key: const ValueKey('air-mobile-settings'),
            tooltip: '设置',
            onPressed: () => unawaited(_mobileSettings()),
            icon: const Icon(Icons.settings_outlined),
          ),
          PopupMenuButton<String>(
            key: const ValueKey('air-header-menu'),
            tooltip: '更多操作',
            onSelected: (v) {
              switch (v) {
                case 'search':
                  _openSearch();
                case 'library':
                  _updateMobile(() => _mode = _AirMode.library);
                case 'add-directory':
                  unawaited(_addDirectory());
                case 'retention':
                  if (_directoryId != null) {
                    unawaited(
                      showAirTaskRetentionDialog(
                        context,
                        service: _service,
                        directoryId: _directoryId!,
                        onChanged: _refresh,
                      ),
                    );
                  }
                case 'project':
                  _selectDirectory(_directoryId!);
                case 'voice':
                  widget.onOpenVoiceCall?.call();
                case 'refresh':
                  unawaited(_refresh());
                case 'console-web':
                  _openWebConsole();
                case 'import':
                  unawaited(_importExternal());
                case 'guide':
                  unawaited(_tourKey.currentState?.restart() ?? Future.value());
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'search', child: Text('搜索目录与任务')),
              const PopupMenuItem(value: 'library', child: Text('工作目录库')),
              const PopupMenuItem(
                value: 'add-directory',
                child: Text('添加工作目录'),
              ),
              if (_directoryId != null)
                const PopupMenuItem(value: 'retention', child: Text('管理任务容量')),
              if (directory != null)
                const PopupMenuItem(value: 'project', child: Text('项目详情与终端')),
              if (widget.onOpenVoiceCall != null)
                const PopupMenuItem(value: 'voice', child: Text('语音通话')),
              const PopupMenuItem(value: 'import', child: Text('导入共享工作区')),
              const PopupMenuItem(value: 'refresh', child: Text('刷新')),
              if (_mode == _AirMode.console)
                const PopupMenuItem(
                  value: 'console-web',
                  child: Text('在网页里打开控制台'),
                ),
              const PopupMenuItem(value: 'guide', child: Text('首次上手引导')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                _error,
                style: const TextStyle(color: AppColors.danger),
              ),
            ),
          Expanded(
            child: switch (_mode) {
              _AirMode.console || _AirMode.recent => _mobileWorkspace(data),
              _AirMode.schedules => _mobileSchedulePanel(data),
              _AirMode.library => AirDirectoryLibrary(
                directories: data?.directories ?? [],
                currentDirectoryId: _directoryId,
                tasksOf: (id) => data?.tasksOf(id) ?? [],
                runningDirectories: runningDirectories,
                onOpen: _selectDirectory,
                onAddDirectory: () => unawaited(_addDirectory()),
                onAction: (directory, action) =>
                    unawaited(_onDirectoryAction(directory, action)),
                addButtonKey: _tourLibraryKey,
              ),
              _AirMode.tasks => _buildDirectory(data, directory, tasks),
            },
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_mode != _AirMode.tasks && _mode != _AirMode.library)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
                child: SizedBox(
                  width: double.infinity,
                  height: 46,
                  child: FilledButton.icon(
                    key: const ValueKey('air-mobile-create'),
                    // 触发器不归某个目录，没选目录也能建。
                    onPressed:
                        directory == null && !(schedules && _mobileHooksTab)
                        ? null
                        : () => schedules
                              ? unawaited(
                                  _mobileHooksTab
                                      ? _mobileHooks.currentState?.openEditor()
                                      : _mobileSchedules.currentState
                                            ?.openEditor(),
                                )
                              : unawaited(
                                  _newTask(
                                    preferDirectoryId: _mode == _AirMode.recent
                                        ? _mobileRecentDir
                                        : null,
                                  ),
                                ),
                    icon: const Icon(Icons.add),
                    label: Text(
                      !schedules
                          ? '新任务'
                          : _mobileHooksTab
                          ? '新建触发器'
                          : '新建定时任务',
                    ),
                  ),
                ),
              ),
            NavigationBar(
              height: 68,
              selectedIndex: schedules
                  ? 2
                  : _mode == _AirMode.recent || _mode == _AirMode.tasks
                  ? 1
                  : 0,
              onDestinationSelected: (i) => _updateMobile(() {
                _mobileRecentFilter = null;
                _mode = [
                  _AirMode.console,
                  _AirMode.recent,
                  _AirMode.schedules,
                ][i];
              }),
              destinations: const [
                NavigationDestination(
                  icon: Icon(Icons.dashboard_outlined),
                  label: '控制台',
                ),
                NavigationDestination(
                  icon: Icon(Icons.list_alt_outlined),
                  label: '最近任务',
                ),
                NavigationDestination(
                  icon: Icon(Icons.schedule),
                  label: '定时任务',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
