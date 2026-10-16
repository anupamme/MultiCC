'use strict';

// ── 会话页头 🪝 钩子按钮（public/chat-hooks.js）──────────────────────────────
// 本会话还没有钩子时，点一下直接新建一条“事件 → 动作”规则（表单是 hook-editor.js 里
// 与定时任务中心共用的那一张）；已有钩子时先列出来，可就地编辑 / 启停 / 删除或再新建
// —— 否则建完就再也看不到、改不了，只能去 Air 的“定时任务 → 触发器任务”里找。
// 按钮上的数字 = 本会话已启用的钩子数。chat.js 在每次会话信息装载后调用
// refresh(sessionId)，所以切会话/切 CLI 后角标会跟着更新。
(function initChatHooks(root) {
  if (!root || !root.document) return;
  const button = () => root.document.getElementById('hook-btn');
  const tr = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  let currentId = new URLSearchParams(root.location.search).get('session') || '';

  async function refresh(sessionId) {
    const element = button();
    if (sessionId) currentId = sessionId;
    if (!element || !currentId || !root.MultiCCHookEditor) return;
    let count = 0;
    try {
      count = (await root.MultiCCHookEditor.listForSession(currentId)).filter(rule => rule.enabled).length;
    } catch (_) { return; }
    element.dataset.state = count ? 'set' : 'off';
    element.textContent = count ? `${tr('hookTitle')} ${count}` : tr('hookTitle');
    element.title = tr('hookBtnTitle', { n: count });
  }

  const editor = () => root.MultiCCHookEditor;
  const openEditor = item => editor().open({ session: { id: currentId, label: currentId }, item: item || null, onSaved: () => refresh() });
  const eventLabel = pattern => { const hit = editor().EVENT_OPTIONS.find(([value]) => value === pattern); return hit ? tr(hit[1]) : pattern; };
  const actionLabel = kind => { const hit = editor().ACTION_OPTIONS.find(([value]) => value === kind); return hit ? tr(hit[1]) : kind; };
  let listDialog = null;

  function el(tag, text, className) {
    const node = root.document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function btn(text, action, className) {
    const node = el('button', text, className);
    node.type = 'button';
    node.onclick = action;
    return node;
  }

  function ensureListDialog() {
    if (listDialog) return listDialog;
    const style = el('style');
    style.textContent = `
dialog.hook-list-dialog{width:calc(100% - 32px);max-width:560px;padding:18px 20px;border:1px solid #d6e2ee;border-radius:14px;background:#fbfdff;color:#294760;font-size:13px}
dialog.hook-list-dialog::backdrop{background:rgba(32,52,74,.35)}
dialog.hook-list-dialog .hook-list-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
dialog.hook-list-dialog h2{margin:0;font-size:17px}
dialog.hook-list-dialog .hook-list-item{border:1px solid #dde7f0;border-radius:10px;padding:10px 12px;margin:0 0 8px;background:#fff}
dialog.hook-list-dialog .hook-list-item.off{opacity:.6}
dialog.hook-list-dialog .hook-list-flow{font-weight:600}
dialog.hook-list-dialog .hook-list-prompt{margin:6px 0 0;white-space:pre-wrap;color:#4b6378}
dialog.hook-list-dialog small{display:block;margin-top:4px;color:#6b7f93}
dialog.hook-list-dialog .hook-list-actions{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
dialog.hook-list-dialog button{font:inherit;padding:4px 10px;border:1px solid #c9d7e5;border-radius:8px;background:#fff;color:inherit;cursor:pointer}
dialog.hook-list-dialog button.danger{color:#c0392b}
dialog.hook-list-dialog .hook-list-close{border:0;background:transparent;font-size:22px;line-height:1;color:#718398}`;
    listDialog = el('dialog', null, 'hook-list-dialog');
    root.document.head.append(style);
    root.document.body.append(listDialog);
    return listDialog;
  }

  async function act(work) {
    try { await work(); } catch (error) { root.alert && root.alert(String((error && error.message) || error)); }
    await refresh();
    await showList();
  }

  // 已有钩子的列表：编辑走共用表单（带 item 即编辑模式），启停 / 删除直接调接口。
  async function showList() {
    const rules = await editor().listForSession(currentId);
    if (!rules.length) { if (listDialog && listDialog.open) listDialog.close(); return void openEditor(null); }
    const dialog = ensureListDialog();
    const head = el('div', null, 'hook-list-head');
    head.append(el('h2', tr('hookTitle')), btn('×', () => dialog.close(), 'hook-list-close'));
    const items = rules.map(rule => {
      const item = { scope: 'session', sessionId: currentId, rule };
      const card = el('div', null, `hook-list-item${rule.enabled ? '' : ' off'}`);
      card.append(el('div', `${rule.name ? `${rule.name} · ` : ''}${rule.on.map(eventLabel).join(' / ')} → ${actionLabel(rule.action.kind)}`, 'hook-list-flow'));
      if (rule.action.prompt) card.append(el('p', rule.action.prompt, 'hook-list-prompt'));
      card.append(el('small', rule.lastFiredAt ? `${tr('hookLastRun')} ${new Date(rule.lastFiredAt).toLocaleString()}` : tr('hookNeverRan')));
      const actions = el('div', null, 'hook-list-actions');
      actions.append(
        btn(tr('airScheduleEdit'), () => { dialog.close(); void openEditor(item); }),
        btn(rule.enabled ? tr('airSchedulePause') : tr('airScheduleEnable'), () => act(() => editor().setEnabled(item, !rule.enabled))),
        btn(tr('airScheduleDelete'), () => { if (!root.confirm || root.confirm(tr('hookDeleteConfirm'))) void act(() => editor().removeItem(item)); }, 'danger'));
      card.append(actions);
      return card;
    });
    const footer = el('div', null, 'hook-list-actions');
    footer.append(btn(tr('hookDialogNew'), () => { dialog.close(); void openEditor(null); }));
    dialog.replaceChildren(head, ...items, footer);
    if (!dialog.open) dialog.showModal();
  }

  function bind() {
    const element = button();
    if (!element) return;
    element.onclick = () => {
      if (!currentId || !editor()) return;
      void showList().catch(() => openEditor(null));
    };
  }

  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', bind);
  else bind();
  root.MultiCCChatHooks = Object.freeze({ refresh });
})(typeof window !== 'undefined' ? window : null);
