'use strict';
// Searchable project switcher. Drag order is shared with the server, palette
// and library; choosing a project uses the shell navigation and keeps recents.
(function initAirDirectoryNav(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text != null) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const translate = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);

  let ctx = null;

  // 把快照里的目录就地排成 ids 的顺序：服务端回来之前，再 render 一次也不会弹回去。
  function applyLocalOrder(data, ids) {
    const list = data && Array.isArray(data.directories) ? data.directories : null;
    if (!list) return;
    const rank = new Map(ids.map((id, index) => [id, index]));
    const tail = ids.length;
    list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : tail) - (rank.has(b.id) ? rank.get(b.id) : tail));
  }

  async function commitOrder(context, ids) {
    applyLocalOrder(context.data, ids);
    try {
      await context.api('/api/directories/order', { ids }, 'PUT');
    } catch (error) {
      context.notice?.(translate('airDirReorderFailed', { error: error.message }));
    }
    // 成功失败都重拉一次：成功时拿到服务端的定稿，失败时把本地乐观顺序纠正回去。
    await context.refresh?.();
  }

  // 让 list 里带 data-dir-id 的行可以拖着换位。行是每次 render 新建的，所以行级
  // 监听直接挂；列表级的 dragover/drop 只挂一次（同一张网格会被反复重画，重复挂
  // 会让一次拖动插入好几次）。
  //
  // options.commit(ids)：自定义落盘方式。控制台目录首页用与 App 共享的
  // ui-layout 语义（PUT /api/ui-layout/dir-order），目录切换浮层仍走旧的
  // /api/directories/order —— 两者共用同一套拖拽交互，但存的不是同一份数据。
  function sortable(list, context, rowSelector = '[data-dir-id]', options = {}) {
    if (!list || !context) return;
    const commit = typeof options.commit === 'function'
      ? options.commit
      : (typeof context.api === 'function' ? ids => commitOrder(context, ids) : null);
    if (!commit) return;
    const order = () => [...list.querySelectorAll(rowSelector)].map(row => row.dataset.dirId);
    const state = list.__dirSortState || (list.__dirSortState = { dragging: null, before: '' });
    state.rowSelector = rowSelector;
    state.context = context;
    state.commit = commit;
    for (const row of list.querySelectorAll(rowSelector)) {
      row.draggable = true;
      row.title = translate('airDirDragHint');
      row.addEventListener('dragstart', event => {
        state.dragging = row;
        state.before = order().join(',');
        row.classList.add('is-dragging');
        list.classList.add('is-sorting');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          try { event.dataTransfer.setData('text/plain', row.dataset.dirId); } catch (_) { /* Safari 偶尔拒绝 */ }
        }
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('is-dragging');
        list.classList.remove('is-sorting');
        const moved = state.dragging;
        state.dragging = null;
        // 拖的中途快照刷新把整栏重画了：这份旧列表已不在页面上，它的顺序不作数。
        if (!moved || !list.isConnected) return;
        const ids = order();
        if (ids.join(',') !== state.before) void state.commit(ids);
      });
    }
    if (list.__dirSortBound) return;
    list.__dirSortBound = true;
    list.addEventListener('dragover', event => {
      const current = list.__dirSortState;
      if (!current || !current.dragging) return;
      const selector = current.rowSelector;
      event.preventDefault();
      const over = event.target && event.target.closest ? event.target.closest(selector) : null;
      if (!over || over === current.dragging || !list.contains(over)) return;
      const box = over.getBoundingClientRect();
      const after = event.clientY > box.top + box.height / 2;
      list.insertBefore(current.dragging, after ? over.nextSibling : over);
    });
    list.addEventListener('drop', event => {
      if (list.__dirSortState?.dragging) event.preventDefault();
    });
  }

  // Click, keyboard and touch share one project menu.
  let flyout = null;
  let hideTimer = null;
  let boundCard = null;

  function hideFlyout() {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (flyout) flyout.hidden = true;
    document.getElementById('library')?.setAttribute('aria-expanded', 'false');
  }

  function ensureFlyout() {
    if (flyout) return flyout;
    flyout = node('nav', null, 'directory-flyout');
    flyout.id = 'directory-flyout';
    flyout.hidden = true;
    flyout.setAttribute('aria-label', translate('airDirSwitchHeading'));

    document.body.append(flyout);
    return flyout;
  }

  // pick：手机「最近任务」借这个侧拉当目录筛选 —— 选中的目录（null = 全部项目）交回
  // 调用方，不跳去目录首页。普通 toggle() 会把它清掉。
  let pick = null;
  function paintFlyout(card) {
    const context = ctx;
    const current = pick ? pick.current : context.directoryId;
    const directories = context?.data?.directories || [];

    const panel = ensureFlyout();
    const list = node('div', null, 'directory-flyout-list');
    for (const directory of directories) {
      const row = node('button', null, 'directory-flyout-row');
      row.type = 'button';
      row.dataset.dirId = directory.id;
      if (directory.id === current) {
        row.classList.add('is-current');
        row.setAttribute('aria-current', 'true');
      }
      row.append(node('strong', directory.name || directory.id), node('small', directory.path || ''));
      row.onclick = () => {
        hideFlyout();
        if (pick) pick.onPick(directory.id); else context.navigate?.(directory.id);
      };
      list.append(row);
    }
    // Preserve the shared server-side project order.
    sortable(list, context);
    const search = node('input');
    search.type = 'search'; search.placeholder = translate('airProjectSearch');
    search.setAttribute('aria-label', translate('airProjectSearch'));
    const empty = node('p', translate('airAdminNoDirectories'), 'admin-empty'); empty.hidden = directories.length > 0;
    search.oninput = () => {
      const query = search.value.trim().toLowerCase();
      for (const row of list.children) row.hidden = !row.textContent.toLowerCase().includes(query);
      empty.hidden = [...list.children].some(row => !row.hidden);
    };
    const all = node('button', translate('airAllProjects'), 'directory-flyout-action'); all.type = 'button';
    if (pick && !current) all.setAttribute('aria-current', 'true');
    all.onclick = () => { hideFlyout(); if (pick) pick.onPick(null); else context.setMode('overview'); };
    const manage = node('button', translate('airManageProjects'), 'directory-flyout-action'); manage.type = 'button';
    manage.onclick = () => { hideFlyout(); context.setMode('library'); };
    const add = node('button', '+ ' + translate('airAddDirectory'), 'directory-flyout-action'); add.type = 'button';
    add.onclick = () => { hideFlyout(); document.getElementById('add-directory').click(); };
    panel.replaceChildren(node('span', translate('airDirSwitchHeading'), 'directory-flyout-title'), search, all, list, empty, manage, add);
    const box = card.getBoundingClientRect();
    const narrow = root.innerWidth <= 760;
    panel.style.left = `${narrow ? 12 : Math.min(box.right + 8, root.innerWidth - 332)}px`;
    panel.style.top = `${narrow ? box.bottom + 8 : box.top}px`;
    panel.style.maxHeight = `${Math.max(100, root.innerHeight - (narrow ? box.bottom + 8 : box.top) - 16)}px`;
    document.getElementById('library').setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    return true;
  }

  function bindCard() {
    const card = document.querySelector('#sidebar .space-card') || document.querySelector('.space-card');
    if (!card || card === boundCard) return;
    boundCard = card;
    document.addEventListener('click', event => {
      if (!card.contains(event.target) && !flyout?.contains(event.target)) hideFlyout();
    });
    document.addEventListener('keydown', event => {
      if (!flyout || flyout.hidden) return;
      if (event.key === 'Escape') { event.stopImmediatePropagation(); hideFlyout(); document.getElementById('library').focus(); }
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && flyout.contains(event.target)) {
        event.preventDefault();
        const choices = [...flyout.querySelectorAll('input, button')].filter(el => !el.hidden);
        const index = choices.indexOf(document.activeElement);
        choices[(index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]?.focus();
      }
    }, true);
    root.addEventListener('resize', hideFlyout);
    root.addEventListener('popstate', hideFlyout);
  }

  // air.js 每次 render 递进来：快照、当前目录、api、notice、refresh、navigate。
  function render(context) {
    if (context) ctx = context;
    bindCard();
    // 侧拉开着时快照变了（别处新增/改名/排序）：就地重画，跟着最新清单走。

  }

  root.MultiCCAirDirectoryNav = { render, sortable, hideFlyout,
    toggle: (options = null) => {
      if (flyout && !flyout.hidden) { hideFlyout(); return; }
      pick = options?.onPick ? options : null;
      if (boundCard && paintFlyout(boundCard)) flyout.querySelector('input')?.focus();
    }, _applyLocalOrder: applyLocalOrder };
})(typeof window !== 'undefined' ? window : null);
