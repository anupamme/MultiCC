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
  function render(next) {
    context = next;
    const { mode, taskId, setMode } = context;
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
    $('recent-all').onclick = () => { root.MultiCCAirAdmin.showAllTasks(); setMode('overview'); };
  }
  root.MultiCCAirNavigation = { write, render, back, go: view => context?.setMode(view),
    restore: () => requestAnimationFrame(() => {
      const scroller = document.querySelector('#console-center:not([hidden]), #admin-center:not([hidden])');
      if (scroller) scroller.scrollTop = history.state?.airScroll || 0;
    }) }; 
})(window);
