'use strict';

// Keep the return destination on the browser entry, so refresh, Back and
// Forward retain the same meaning as the visible return button.
(function (root) {
  const $ = id => document.getElementById(id);
  const primary = new Set(['overview', 'settings', 'schedules', 'tasks', 'library']);
  let context;
  function source() {
    return { url: location.pathname + location.search, title: $('task-title').textContent,
      scroll: document.querySelector('#console-center:not([hidden]), #admin-center:not([hidden])')?.scrollTop || 0 };
  }
  function write(url, state = {}, replace = false) {
    const previous = replace ? history.state?.airPrevious : source();
    if (!replace) history.replaceState({ ...history.state, airScroll: previous.scroll }, '');
    history[replace ? 'replaceState' : 'pushState']({ ...state, airPrevious: previous }, '', url);
  }
  function back() {
    if (history.state?.airPrevious?.url?.startsWith('/air')) history.back();
    else context.setMode(context.mode === 'attention' || ['docs', 'memory', 'taskgraph'].includes(context.mode) ? 'overview' : 'settings');
  }
  // 控制台 → 目录 → 任务是三层浮层：从控制台点开的目录页（来路是 view=overview）
  // 带一颗「关闭」，关掉退回控制台；目录里再开任务走 air.js 的 #chat-layer，关掉
  // 回到目录。开着任务时历史条目的来路是目录本身，所以「是不是一层」只在没开任务
  // 时重算 —— 否则关掉任务那一下 class 被摘了又挂回来，滑入动画会再放一遍。
  let consoleLayer = false;
  const fromConsole = entry => { try { return new URL(entry.url, location.origin).searchParams.get('view') === 'overview'; } catch (_) { return false; } };
  function closeLayer() {
    const layout = $('task-layout');
    const leave = () => {
      layout.classList.remove('is-leaving');
      if (history.state?.airPrevious && fromConsole(history.state.airPrevious)) history.back();
      else context.setMode('overview');
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { leave(); return; }
    layout.classList.add('is-leaving');
    setTimeout(leave, 160);
  }
  function renderLayer(mode, taskId) {
    if (mode !== 'tasks') consoleLayer = false;
    else if (!taskId) consoleLayer = !!history.state?.airPrevious && fromConsole(history.state.airPrevious);
    $('task-layout').classList.toggle('is-console-layer', consoleLayer);
    const close = $('directory-layer-close');
    if (!close) return;
    close.hidden = !consoleLayer;
    close.onclick = closeLayer;
  }
  function render(next) {
    context = next;
    const { mode, taskId, setMode } = context;
    renderLayer(mode, taskId);
    const button = $('page-back');
    button.hidden = !!taskId || primary.has(mode);
    const previous = history.state?.airPrevious;
    const fallback = mode === 'attention' || ['docs', 'memory', 'taskgraph'].includes(mode) ? 'airConsole' : 'airSettingsCenter';
    button.textContent = '‹ ' + (previous?.title || root.t(fallback));
    button.onclick = back;
    if (!button.hidden) {
      const crumbs = $('task-breadcrumb');
      crumbs.replaceChildren();
      const origin = document.createElement('button');
      origin.type = 'button'; origin.textContent = previous?.title || root.t(fallback); origin.onclick = back;
      crumbs.append(origin, document.createTextNode(' / ' + $('task-title').textContent));
    }
    for (const [id, on] of [['overview', mode === 'overview'], ['schedules', mode === 'schedules'],
      ['side-more', mode === 'settings' || (!primary.has(mode) && !['attention', 'docs', 'memory', 'taskgraph'].includes(mode))]]) {
      $(id).classList.toggle('active', on);
      if (on) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
    }
    $('side-more').onclick = () => setMode('settings');
    $('recent-all').onclick = () => { root.MultiCCAirAdmin.showAllTasks(); root.MultiCCAirAdmin.setConsoleView('tasks'); setMode('overview'); };
  }
  root.MultiCCAirNavigation = { write, render, back, closeLayer, go: view => context?.setMode(view),
    restore: () => requestAnimationFrame(() => {
      const scroller = document.querySelector('#console-center:not([hidden]), #admin-center:not([hidden])');
      if (scroller) scroller.scrollTop = history.state?.airScroll || 0;
    }) }; 
})(window);
