'use strict';

// 手机壳复用真实任务、项目与创建动作，桌面继续使用侧栏。
(function (root) {
  const $ = id => document.getElementById(id);
  const mobile = matchMedia('(max-width: 760px)');
  let ctx;
  // filter 管「最近任务」页，consoleView 管控制台那张卡；从卡片点「全部 ›」会带着
  // 当前那一格过去，并清掉上次留下的搜索词（要看的是这一格的完整清单）。
  let query = '', filter = 'recent', consoleView = 'recent';
  // 控制台不分目录，看的是所有项目；按目录看在「最近任务」页里选（null = 全部项目）。
  // 这只是这一页的筛选，不改全局「当前目录」。
  let recentDir = null;
  const make = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const button = (text, action, cls) => {
    const el = make('button', text, cls); el.type = 'button'; el.onclick = action; return el;
  };
  // 手机「最近任务」按最后活动时间倒序，pin 住的排最前。不能沿用侧栏那份「本浏览器
  // 打开过」的顺序：在电脑上新建、手机上没点开过的任务会被挤到底，而服务端 tasks
  // 本身是从旧到新排的，补位进来的全是最老的任务。
  // 控制台那张卡只摆 3 条，不带 pin（pin 多了会把它整张占满），只看谁最近动过。
  function recentRows(context, withPins = true, directoryId = null) {
    const { data } = context;
    const tasks = (data.tasks || []).filter(task => !directoryId || task.dirId === directoryId);
    const byId = new Map(tasks.map(task => [task.id, task]));
    const pinned = withPins ? (data.taskPins || []).map(id => byId.get(id)).filter(Boolean) : [];
    const ids = new Set(pinned.map(task => task.id));
    const activeAt = task => Number(task.lastMessageAt || task.updatedAt || 0);
    return [...pinned, ...tasks.filter(task => !ids.has(task.id)).sort((a, b) => activeAt(b) - activeAt(a))];
  }
  // 状态格的口径只有一份：交给控制台的 filterTasks（今日完成 = doneToday 等），这里
  // 只拿它筛出的 id，顺序仍是上面的「最近活动在前」。recent = 未归档。
  // 手机宽度一行放不下五格，「今日完成」排第二，不用横滑就能点到。
  const MOBILE_FILTERS = [['recent', 'airRecentTasks'], ['today', 'airAdminTileToday'], ['running', 'airAdminTileRunning'],
    ['waiting', 'airAdminTileWaiting'], ['error', 'airAdminTileError']];
  function filterRows(rows, view) {
    if (view === 'recent') return rows.filter(task => task.status !== 'archived');
    if (view === 'all') return rows;
    const keep = new Set(root.MultiCCAirAdmin.filterTasks(rows, { status: view }).map(task => task.id));
    return rows.filter(task => keep.has(task.id));
  }
  function taskRow(task, context) {
    const row = button('', () => context.navigate(task.dirId, task.id), 'mobile-task-row');
    row.dataset.taskId = task.id;
    const copy = make('span', null, 'mobile-task-copy');
    const stage = task.recordType === 'planned' ? context.label(task.workflowStage || task.status) : '';
    // 控制台和「全部项目」跨目录，每行都带上目录名，免得同名任务分不清。
    copy.append(make('strong', task.title), make('small', [context.directoryName(task.dirId), task.phase || stage].filter(Boolean).join(' · ')));
    const state = root.MultiCCAirAdmin.taskStatus(task);
    row.append(copy, make('span', context.label(state), `mobile-task-status state-${state}`));
    return row;
  }
  function renderRecent(context) {
    ctx = { ...ctx, ...context };
    const content = $('admin-content');
    if (recentDir && !context.data.directories.some(dir => dir.id === recentDir)) recentDir = null;
    const signature = JSON.stringify([recentDir, context.data.tasks, ctx.recentTasks, root.currentLang, filter]);
    if (content.dataset.mobileRecent === signature && content.querySelector('#mobile-task-search')) return;
    const focus = document.activeElement?.id === 'mobile-task-search';
    const start = document.activeElement?.selectionStart;
    const wrapper = make('section', null, 'mobile-recent-panel');
    const search = make('input'); search.type = 'search'; search.id = 'mobile-task-search'; search.value = query;
    search.placeholder = root.t('airAdminSearchTasksLabel'); search.setAttribute('aria-label', search.placeholder);
    const tabs = make('div', null, 'mobile-task-filters');
    const list = make('div', null, 'mobile-task-list');
    const paint = () => {
      let rows = filterRows(recentRows(ctx, true, recentDir), filter);
      if (filter === 'recent') rows = rows.slice(0, 30);
      const needle = query.trim().toLowerCase();
      rows = rows.filter(task => !needle || [task.title, task.phase, task.goal, task.summary].some(value => String(value || '').toLowerCase().includes(needle)));
      list.replaceChildren(...rows.map(task => taskRow(task, ctx)));
      if (!rows.length) list.append(make('p', root.t('airAdminNoMatchingTasks'), 'admin-empty'));
      for (const tab of tabs.children) tab.setAttribute('aria-pressed', String(tab.dataset.filter === filter));
    };
    for (const [value, key] of [...MOBILE_FILTERS, ['all', 'airAdminFilterAll']]) {
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
    // 最近任务页里它是目录筛选（侧拉选完留在这页）；定时任务、目录首页照旧是切目录。
    const project = button('', event => {
      event.stopPropagation();
      root.MultiCCAirDirectoryNav.toggle(ctx.mode !== 'recent' ? null : {
        current: recentDir,
        onPick: id => { recentDir = id; render(ctx); renderRecent(ctx); },
      });
    }, 'air-mobile-project'); project.id = 'air-mobile-project';
    // 控制台不分目录，顶栏那格留空（页面大标题已经写着「控制台」）。
    const spacer = make('span', null, 'air-mobile-spacer'); spacer.id = 'air-mobile-spacer'; spacer.setAttribute('aria-hidden', 'true');
    const settings = button('⚙', () => ctx.setMode('settings'), 'air-mobile-settings'); settings.id = 'air-mobile-settings';
    settings.setAttribute('aria-label', root.t('airSettingsCenter'));
    top.append(project, spacer, settings); document.querySelector('main').prepend(top);
    const dock = make('div', null, 'air-mobile-dock'); dock.id = 'air-mobile-dock';
    const create = button('', () => {
      $(ctx.mode === 'schedules' ? 'schedule-create' : 'create').click();
      // 最近任务按某个目录在看时，新任务默认建到那个目录（弹窗里仍可改）。
      const pickDir = $('quick-task-dialog-directory');
      if (ctx.mode === 'recent' && recentDir && $('quick-task-dialog').open && pickDir) {
        pickDir.value = recentDir; pickDir.dispatchEvent(new Event('change'));
      }
    }, 'primary'); create.id = 'air-mobile-create';
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
    const all = recentRows(ctx, false);
    const rows = filterRows(all, consoleView);
    head.append(make('h3', root.t(MOBILE_FILTERS.find(([value]) => value === consoleView)[1])),
      button(`${root.t('airAdminFilterAll')} ${rows.length} ›`, () => { filter = consoleView; query = ''; ctx.setMode('recent'); }));
    // 桌面那排统计格在手机上藏掉了（太占地方），这里换成一行带数量的小格。
    const tabs = make('div', null, 'mobile-task-filters mobile-console-filters');
    for (const [value, key] of MOBILE_FILTERS) {
      const count = value === 'recent' ? '' : ` ${filterRows(all, value).length}`;
      const tab = button(root.t(key) + count, () => { consoleView = value; paintConsole(); });
      tab.dataset.filter = value; tab.setAttribute('aria-pressed', String(value === consoleView)); tabs.append(tab);
    }
    // 「最近」只摆 3 条，按状态看时多给两条，免得今天完成的刚好被截掉一半。
    panel.append(head, tabs, ...rows.slice(0, consoleView === 'recent' ? 3 : 5).map(task => taskRow(task, ctx)));
    if (!rows.length) panel.append(make('p', root.t('airAdminNoMatchingTasks'), 'admin-empty'));
    content.querySelector('.mobile-console-recent')?.remove();
    const priority = content.querySelector('.console-priority-grid');
    if (priority) priority.after(panel); else content.prepend(panel);
    // 选中的那格挪进可见区（只横向，不带动页面纵向滚动）。
    const picked = tabs.querySelector('[aria-pressed="true"]');
    if (picked && picked.offsetLeft + picked.offsetWidth > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = picked.offsetLeft - 14;
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
    const recentPick = ctx.data.directories.find(item => item.id === recentDir);
    const overview = ctx.mode === 'overview';
    $('air-mobile-project').hidden = overview;
    $('air-mobile-spacer').hidden = !overview;
    $('air-mobile-project').textContent = (ctx.mode === 'recent'
      ? recentPick?.name || root.t('airAllProjects')
      : dir?.name || root.t('airHeaderNoDirectory')) + ' ⌄';
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
