'use strict';

// 手机壳复用真实任务、项目与创建动作，桌面继续使用侧栏。
(function (root) {
  const $ = id => document.getElementById(id);
  const mobile = matchMedia('(max-width: 760px)');
  let ctx;
  const make = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const button = (text, action, cls) => {
    const el = make('button', text, cls); el.type = 'button'; el.onclick = action; return el;
  };
  const admin = () => root.MultiCCAirAdmin;
  // 底部导航三项：控制台 / 定时任务 / 项目。原来的「最近任务」一项并进了控制台那份
  // 不截条数的清单（air-admin.js）；「项目」就是控制台的「按目录」看法 —— 手机上
  // 页内那道 tab 藏着，由这两项承担。目录首页（tasks）与目录库（library）都归「项目」。
  const NAV = [['tasks', '▦', 'airConsole'], ['schedules', '◷', 'airScheduledTasks'], ['dirs', '▤', 'airWorkspace']];
  function navTarget(view) {
    if (view === 'schedules') return ctx.setMode('schedules');
    admin().setConsoleView(view);
    ctx.setMode('overview');
  }
  function navActive(view) {
    if (ctx.mode === 'schedules') return view === 'schedules';
    if (ctx.mode === 'overview') return view === admin().consoleView();
    return view === 'dirs' && (ctx.mode === 'tasks' || ctx.mode === 'library');
  }
  function mount() {
    if ($('air-mobile-top')) return;
    const top = make('div', null, 'air-mobile-top'); top.id = 'air-mobile-top';
    // 定时任务、目录首页里它是切目录（控制台跨全部项目，那一页不显示它）。
    const project = button('', event => {
      event.stopPropagation();
      root.MultiCCAirDirectoryNav.toggle(null);
    }, 'air-mobile-project'); project.id = 'air-mobile-project';
    // 控制台不分目录，顶栏那格留空（页面大标题已经写着「控制台」）。
    const spacer = make('span', null, 'air-mobile-spacer'); spacer.id = 'air-mobile-spacer'; spacer.setAttribute('aria-hidden', 'true');
    const settings = button('⚙', () => ctx.setMode('settings'), 'air-mobile-settings'); settings.id = 'air-mobile-settings';
    settings.setAttribute('aria-label', root.t('airSettingsCenter'));
    top.append(project, spacer, settings); document.querySelector('main').prepend(top);
    const dock = make('div', null, 'air-mobile-dock'); dock.id = 'air-mobile-dock';
    const create = button('', () => {
      $(ctx.mode === 'schedules' ? 'schedule-create' : 'create').click();
      // 控制台清单按某个项目在看时，新任务默认建到那个项目（弹窗里仍可改）。
      const pickDir = $('quick-task-dialog-directory'), consoleDir = admin().consoleDirectory();
      if (ctx.mode === 'overview' && consoleDir && $('quick-task-dialog').open && pickDir) {
        pickDir.value = consoleDir; pickDir.dispatchEvent(new Event('change'));
      }
    }, 'primary'); create.id = 'air-mobile-create';
    const nav = make('nav'); nav.setAttribute('aria-label', root.t('airSidebarNav'));
    // 「项目」一项不能藏进 ⋯ 菜单：目录与终端入口摸不到，用户会以为功能被删了。
    for (const [view, glyph, key] of NAV) {
      const tab = button('', () => navTarget(view)); tab.dataset.mobileView = view;
      tab.append(make('span', glyph, 'mobile-nav-icon'), make('span', root.t(key))); nav.append(tab);
    }
    dock.append(create, nav); document.querySelector('main').append(dock);
  }
  // 控制台在手机上只多一样东西：资料入口（文档 / 记忆 / 任务图），挂进 air-admin.js
  // 留的空槽。任务清单就是控制台自己那份（不截条数），这里不再另摆一张缩小版。
  function paintConsole() {
    const content = $('console-content');
    if (!mobile.matches || ctx.mode !== 'overview' || !content) return;
    let resources = content.querySelector('.mobile-resources');
    if (!resources) {
      resources = make('details', null, 'mobile-resources'); resources.append(make('summary', root.t('airMaterials')));
      for (const [mode, key] of [['docs', 'airDocs'], ['memory', 'airMemoryGraph'], ['taskgraph', 'airTaskGraph']]) resources.append(button(root.t(key), () => ctx.setMode(mode)));
    }
    const slot = document.getElementById('console-mobile-slot');
    if (slot) slot.replaceChildren(resources); else content.append(resources);
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
    const primary = ['overview', 'schedules', 'tasks', 'library'].includes(ctx.mode) && !ctx.taskId;
    document.body.classList.toggle('air-mobile-root', primary);
    document.body.classList.toggle('air-mobile-secondary', !primary && !ctx.taskId);
    document.body.dataset.airView = ctx.mode;
    $('air-mobile-top').hidden = !primary;
    $('air-mobile-dock').hidden = !primary;
    const dir = ctx.data.directories.find(item => item.id === ctx.directoryId);
    const overview = ctx.mode === 'overview';
    $('air-mobile-project').hidden = overview;
    $('air-mobile-spacer').hidden = !overview;
    $('air-mobile-project').textContent = (dir?.name || root.t('airHeaderNoDirectory')) + ' ⌄';
    $('air-mobile-project').setAttribute('aria-label', root.t('airDirSwitchHeading'));
    $('air-mobile-settings').setAttribute('aria-label', root.t('airSettingsCenter'));
    $('air-mobile-create').textContent = ctx.mode === 'schedules' ? root.t('airNewScheduledTask') : root.t('airNewTask');
    $('air-mobile-create').disabled = ctx.mode !== 'schedules' && !dir;
    for (const tab of document.querySelectorAll('[data-mobile-view]')) {
      const on = navActive(tab.dataset.mobileView);
      tab.classList.toggle('active', on); if (on) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    }
    // 「项目」那一项落在控制台的目录看法上：页头跟着叫「项目」，和底部高亮那一项同名。
    if (mobile.matches && ctx.mode === 'overview' && admin().consoleView() === 'dirs') $('task-title').textContent = root.t('airWorkspace');
    renderSettingsHeader();
    paintConsole();
  }
  mobile.addEventListener('change', () => { if (ctx) { root.MultiCCAirNavigation.render(ctx); if (root.MultiCCAirAdmin.modes.has(ctx.mode)) root.MultiCCAirAdmin.render(ctx.mode, ctx, true); render(ctx); } });
  root.MultiCCAirMobile = { render, renderSettingsHeader,
    decorateConsole: context => { ctx = { ...ctx, ...context, mode: 'overview' }; paintConsole(); } };
})(window);
