'use strict';

// 手机壳复用真实任务、项目与创建动作，桌面继续使用侧栏。
(function (root) {
  const $ = id => document.getElementById(id);
  const mobile = matchMedia('(max-width: 760px)');
  let ctx;
  let query = '', filter = 'recent';
  const make = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const button = (text, action, cls) => {
    const el = make('button', text, cls); el.type = 'button'; el.onclick = action; return el;
  };
  function recentRows(context) {
    const { data, directoryId } = context;
    const recent = context.recentTasks || [];
    const ids = new Set(recent.map(task => task.id));
    return [...recent, ...(data.tasks || []).filter(task => !ids.has(task.id))]
      .filter(task => !directoryId || task.dirId === directoryId);
  }
  function taskRow(task, context) {
    const row = button('', () => context.navigate(task.dirId, task.id), 'mobile-task-row');
    row.dataset.taskId = task.id;
    const copy = make('span', null, 'mobile-task-copy');
    const stage = task.recordType === 'planned' ? context.label(task.workflowStage || task.status) : '';
    copy.append(make('strong', task.title), make('small', task.phase || stage || context.directoryName(task.dirId)));
    const state = root.MultiCCAirAdmin.taskStatus(task);
    row.append(copy, make('span', context.label(state), `mobile-task-status state-${state}`));
    return row;
  }
  function renderRecent(context) {
    ctx = { ...ctx, ...context };
    const content = $('admin-content');
    const signature = JSON.stringify([context.directoryId, context.data.tasks, ctx.recentTasks, root.currentLang]);
    if (content.dataset.mobileRecent === signature && content.querySelector('#mobile-task-search')) return;
    const focus = document.activeElement?.id === 'mobile-task-search';
    const start = document.activeElement?.selectionStart;
    const wrapper = make('section', null, 'mobile-recent-panel');
    const search = make('input'); search.type = 'search'; search.id = 'mobile-task-search'; search.value = query;
    search.placeholder = root.t('airAdminSearchTasksLabel'); search.setAttribute('aria-label', search.placeholder);
    const tabs = make('div', null, 'mobile-task-filters');
    const list = make('div', null, 'mobile-task-list');
    const paint = () => {
      let rows = recentRows(ctx);
      if (filter === 'waiting' || filter === 'running' || filter === 'error') rows = rows.filter(task => root.MultiCCAirAdmin.taskStatus(task) === filter);
      else if (filter === 'recent') rows = rows.filter(task => task.status !== 'archived').slice(0, 30);
      const needle = query.trim().toLowerCase();
      rows = rows.filter(task => !needle || [task.title, task.phase, task.goal, task.summary].some(value => String(value || '').toLowerCase().includes(needle)));
      list.replaceChildren(...rows.map(task => taskRow(task, ctx)));
      if (!rows.length) list.append(make('p', root.t('airAdminNoMatchingTasks'), 'admin-empty'));
      for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.filter === filter));
    };
    for (const [value, key] of [['recent', 'airRecentTasks'], ['waiting', 'airAdminTileWaiting'], ['running', 'airAdminTileRunning'], ['error', 'airAdminTileError'], ['all', 'airAdminFilterAll']]) {
      const tab = button(root.t(key), () => { filter = value; paint(); }); tab.dataset.filter = value; tabs.append(tab);
    }
    search.oninput = () => { query = search.value; paint(); };
    wrapper.append(search, tabs, list); content.replaceChildren(wrapper); content.dataset.mobileRecent = signature;
    paint();
    if (focus) { search.focus(); search.setSelectionRange?.(start, start); }
  }
  function mount() {
    if ($('air-mobile-top')) return;
    const top = make('div', null, 'air-mobile-top'); top.id = 'air-mobile-top';
    const project = button('', event => { event.stopPropagation(); root.MultiCCAirDirectoryNav.toggle(); }, 'air-mobile-project'); project.id = 'air-mobile-project';
    const settings = button('⚙', () => ctx.setMode('settings'), 'air-mobile-settings'); settings.id = 'air-mobile-settings';
    settings.setAttribute('aria-label', root.t('airSettingsCenter'));
    top.append(project, settings); document.querySelector('main').prepend(top);
    const dock = make('div', null, 'air-mobile-dock'); dock.id = 'air-mobile-dock';
    const create = button('', () => $(ctx.mode === 'schedules' ? 'schedule-create' : 'create').click(), 'primary'); create.id = 'air-mobile-create';
    const nav = make('nav'); nav.setAttribute('aria-label', root.t('airSidebarNav'));
    for (const [view, glyph, key] of [['overview', '▦', 'airConsole'], ['recent', '☷', 'airRecentTasks'], ['schedules', '◷', 'airScheduledTasks']]) {
      const tab = button('', () => ctx.setMode(view)); tab.dataset.mobileView = view;
      tab.append(make('span', glyph, 'mobile-nav-icon'), make('span', root.t(key))); nav.append(tab);
    }
    dock.append(create, nav); document.querySelector('main').append(dock);
  }
  function paintConsole() {
    const content = $('console-content');
    if (!mobile.matches || ctx.mode !== 'overview' || !content) return;
    const panel = make('section', null, 'mobile-console-recent');
    const head = make('div', null, 'mobile-section-head');
    head.append(make('h3', root.t('airRecentTasks')), button(root.t('airAdminFilterAll') + ' ›', () => ctx.setMode('recent')));
    panel.append(head, ...recentRows(ctx).filter(task => task.status !== 'archived').slice(0, 3).map(task => taskRow(task, ctx)));
    if (panel.children.length === 1) panel.append(make('p', root.t('airAdminNoMatchingTasks'), 'admin-empty'));
    content.querySelector('.mobile-console-recent')?.remove();
    const priority = content.querySelector('.console-priority-grid');
    if (priority) priority.after(panel); else content.prepend(panel);
    // 资料入口折叠起来，配置只保留右上角设置。
    if (!content.querySelector('.mobile-resources')) {
      const resources = make('details', null, 'mobile-resources'); resources.append(make('summary', root.t('airMaterials')));
      for (const [mode, key] of [['docs', 'airDocs'], ['memory', 'airMemoryGraph'], ['taskgraph', 'airTaskGraph']]) resources.append(button(root.t(key), () => ctx.setMode(mode)));
      content.append(resources);
    }
  }
  function renderSettingsHeader() {
    if (!mobile.matches || ctx.mode !== 'settings') return;
    const category = new URLSearchParams(location.search).get('category');
    const keys = ['airSettingsModels', 'airSettingsMobile', 'airSettingsComputer', 'airSettingsData', 'airSettingsAdvanced'];
    if (keys.includes(category)) $('task-title').textContent = root.t(category);
    const back = $('page-back'); back.hidden = false;
    back.textContent = '‹ ' + (history.state?.airPrevious?.title || root.t(category ? 'airSettingsCenter' : 'airConsole'));
    back.onclick = () => history.state?.airPrevious?.url?.startsWith('/air') ? history.back() : ctx.setMode(category ? 'settings' : 'overview');
  }
  function render(context) {
    ctx = context; mount();
    const primary = ['overview', 'recent', 'schedules', 'tasks', 'library'].includes(ctx.mode) && !ctx.taskId;
    document.body.classList.toggle('air-mobile-root', primary);
    document.body.classList.toggle('air-mobile-secondary', !primary && !ctx.taskId);
    document.body.dataset.airView = ctx.mode;
    $('air-mobile-top').hidden = !primary;
    $('air-mobile-dock').hidden = !primary;
    const dir = ctx.data.directories.find(item => item.id === ctx.directoryId);
    $('air-mobile-project').textContent = (dir?.name || root.t('airHeaderNoDirectory')) + ' ⌄';
    $('air-mobile-project').setAttribute('aria-label', root.t('airDirSwitchHeading'));
    $('air-mobile-settings').setAttribute('aria-label', root.t('airSettingsCenter'));
    $('air-mobile-create').textContent = ctx.mode === 'schedules' ? root.t('airNewScheduledTask') : root.t('airNewTask');
    $('air-mobile-create').disabled = ctx.mode !== 'schedules' && !dir;
    for (const tab of document.querySelectorAll('[data-mobile-view]')) {
      const on = tab.dataset.mobileView === ctx.mode;
      tab.classList.toggle('active', on); if (on) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    }
    renderSettingsHeader();
    paintConsole();
  }
  mobile.addEventListener('change', () => { if (ctx) { root.MultiCCAirNavigation.render(ctx); if (root.MultiCCAirAdmin.modes.has(ctx.mode)) root.MultiCCAirAdmin.render(ctx.mode, ctx, true); render(ctx); } });
  root.MultiCCAirMobile = { render, renderRecent, renderSettingsHeader,
    decorateConsole: context => { ctx = { ...ctx, ...context, mode: 'overview' }; paintConsole(); } };
})(window);
