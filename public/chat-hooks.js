'use strict';

// ── 会话页头 🪝 钩子按钮（public/chat-hooks.js）──────────────────────────────
// 点一下为当前会话新建一条“事件 → 动作”规则（表单是 hook-editor.js 里与定时任务中心
// 共用的那一张）。按钮上的数字 = 本会话已启用的钩子数；全部钩子（含其它会话和全局）
// 在 Air 的“定时任务 → 触发器任务”里统一查看、编辑。chat.js 在每次会话信息装载
// 后调用 refresh(sessionId)，所以切会话/切 CLI 后角标会跟着更新。
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

  function bind() {
    const element = button();
    if (!element) return;
    element.onclick = () => {
      if (!currentId || !root.MultiCCHookEditor) return;
      void root.MultiCCHookEditor.open({ session: { id: currentId, label: currentId }, onSaved: () => refresh() });
    };
  }

  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', bind);
  else bind();
  root.MultiCCChatHooks = Object.freeze({ refresh });
})(typeof window !== 'undefined' ? window : null);
