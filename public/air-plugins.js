'use strict';

// Air「插件」面板 —— plugins/ 目录里自包含插件的入口页（侧栏「资料与插件」区）。
// 这一层只做两件事：把 /api/plugins 的清单画成卡片；点「打开」后用 iframe 嵌
// 插件自带的 UI（/plugins/<id>/<manifest.ui>）。插件的全部交互都发生在它自己的
// 页面里（再经 /api/plugins/<id>/run 与它的 Rust 二进制对话），所以第二个插件
// 落地时这里一行都不用改 —— 新目录复制进 plugins/ 即出现在清单上。
// 后端契约见 src/routes/plugins.js：
//   GET  /api/plugins
//   静态 /plugins/<id>/<ui 子树>
(function initAirPlugins(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  // 当前打开的插件 id 存模块上：面板每次重开都重建 DOM（air-admin.js 的
  // renderNative 走 render(host, ctx)），iframe 不能跟着整页重绘被拆掉重来。
  let activeId = null;
  let plugins = null;
  let styleNode = null;

  function styleSheet() {
    if (styleNode) return styleNode;
    styleNode = document.createElement('style');
    styleNode.textContent = `
.air-plugins { display: grid; gap: 12px; }
.air-plugins-list { display: grid; gap: 10px; }
.air-plugins-card { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 13px 15px; border: 1px solid var(--hairline); border-radius: 12px; background: #fff; box-shadow: var(--shadow-1); }
.air-plugins-icon { flex: 0 0 auto; font-size: 20px; }
.air-plugins-copy { min-width: 0; flex: 1 1 220px; }
.air-plugins-name { color: #2f536f; font-size: 12.5px; font-weight: 650; }
.air-plugins-version { margin-left: 8px; color: var(--faint); font-size: 9.5px; font-weight: 500; }
.air-plugins-desc { margin-top: 3px; color: #56718b; font-size: 10.5px; line-height: 1.45; }
.air-plugins-open { flex: 0 0 auto; min-height: 32px; padding: 4px 14px; color: #fff; border: 1px solid transparent; border-radius: 9px; background: #3d8bd8; font-size: 10.5px; }
.air-plugins-open:hover:not(:disabled) { background: #2f7ac4; }
.air-plugins-open:disabled { cursor: not-allowed; opacity: .55; }
.air-plugins-badge { flex: 0 0 auto; padding: 3px 8px; border-radius: 6px; background: #fdf4f1; color: #a6533c; font-size: 9.5px; }
.air-plugins-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.air-plugins-back { min-height: 32px; padding: 4px 12px; color: #2f536f; border: 1px solid var(--hairline); border-radius: 9px; background: #f6f9fc; font-size: 10.5px; }
.air-plugins-back:hover { background: #eef5fd; }
.air-plugins-frame { width: 100%; height: min(78vh, 900px); border: 1px solid var(--hairline); border-radius: 12px; background: #fff; }
.air-plugins-hint { margin: 0; color: var(--muted); font-size: 10px; }
.air-plugins-empty { padding: 26px 18px; text-align: center; border: 1px dashed var(--hairline); border-radius: 12px; }
.air-plugins-empty-title { color: #2f536f; font-size: 12.5px; font-weight: 650; }
.air-plugins-empty-hint { margin: 8px auto 0; max-width: 46em; color: #56718b; font-size: 10.5px; line-height: 1.6; }
.air-plugins-empty-hint code { padding: 1px 5px; border-radius: 5px; background: #eef3f8; color: #40607e; font-size: 10px; }
`;
    return styleNode;
  }

  function button(text, handler, className) {
    const node = make('button', text, className);
    node.type = 'button';
    node.onclick = handler;
    return node;
  }

  // 插件名/描述跟随界面语言：manifest 里的 nameEn/descriptionEn 是给英文界面
  // 的降级位，没写就回落到主文案（多数插件只有一份中文文案）。
  function pickText(entry, base, en) {
    const lang = (typeof root.getLang === 'function' && root.getLang()) || 'zh';
    return (lang === 'en' && entry[en]) ? entry[en] : entry[base];
  }

  function renderCard(entry) {
    const card = make('article', null, 'air-plugins-card');
    card.append(make('span', entry.icon || '🧩', 'air-plugins-icon'));
    const copy = make('div', null, 'air-plugins-copy');
    const title = make('div', null, 'air-plugins-name');
    title.append(document.createTextNode(pickText(entry, 'name', 'nameEn')));
    title.append(make('span', 'v' + (entry.version || ''), 'air-plugins-version'));
    copy.append(title, make('div', pickText(entry, 'description', 'descriptionEn'), 'air-plugins-desc'));
    if (!entry.engine.available) {
      copy.append(make('div', entry.engine.reason || t('airPluginsEngineMissing'), 'air-plugins-badge'));
    }
    card.append(copy);
    const open = button(t('airPluginsOpen'), () => { activeId = entry.id; paint(document.getElementById('admin-content'), contextRef); }, 'air-plugins-open');
    open.disabled = !entry.engine.available || !entry.ui;
    if (!entry.ui) open.title = '该插件没有自带界面';
    card.append(open);
    return card;
  }

  function renderDetail(host, entry) {
    const wrap = make('section', null, 'air-plugins');
    const head = make('div', null, 'air-plugins-head');
    head.append(button(t('airPluginsBack'), () => { activeId = null; paint(host, contextRef); }, 'air-plugins-back'));
    head.append(make('strong', `${entry.icon || '🧩'} ${pickText(entry, 'name', 'nameEn')}`));
    head.append(make('span', 'v' + (entry.version || ''), 'air-plugins-version'));
    head.append(make('span', entry.engine.reason || t('airPluginsFrameHint'), 'air-plugins-hint'));
    const frame = make('iframe', null, 'air-plugins-frame');
    frame.src = `/plugins/${encodeURIComponent(entry.id)}/${(entry.ui || '').replace(/^\/+/, '')}`;
    frame.title = pickText(entry, 'name', 'nameEn');
    wrap.append(head, frame);
    host.replaceChildren(styleSheet(), wrap);
  }

  let contextRef = null;

  function paint(host, context) {
    if (!host) return;
    if (context) contextRef = context;
    if (activeId && plugins) {
      const entry = plugins.find(plugin => plugin.id === activeId);
      if (entry && entry.engine.available && entry.ui) return renderDetail(host, entry);
      activeId = null; // 插件被移除或引擎失效：回清单，别把用户留在空 iframe 上
    }
    const wrap = make('section', null, 'air-plugins');
    if (plugins == null) {
      const loading = make('p', t('airPluginsLoading'), 'air-plugins-hint');
      wrap.append(loading);
      host.replaceChildren(styleSheet(), wrap);
      return;
    }
    if (!plugins.length) {
      const empty = make('div', null, 'air-plugins-empty');
      empty.append(make('div', t('airPluginsEmptyTitle'), 'air-plugins-empty-title'));
      const hint = make('p', null, 'air-plugins-empty-hint');
      hint.append(document.createTextNode(t('airPluginsEmptyHintA')));
      hint.append(make('code', 'plugin.json'));
      hint.append(document.createTextNode(t('airPluginsEmptyHintB')));
      empty.append(hint);
      wrap.append(empty);
      host.replaceChildren(styleSheet(), wrap);
      return;
    }
    const list = make('div', null, 'air-plugins-list');
    for (const entry of plugins) list.append(renderCard(entry));
    wrap.append(list);
    host.replaceChildren(styleSheet(), wrap);
  }

  async function load(context) {
    try {
      const payload = await context.api('/api/plugins');
      plugins = Array.isArray(payload && payload.plugins) ? payload.plugins : [];
    } catch (error) {
      plugins = [];
      context.notice?.(t('airPluginsLoadFail') + (error && error.message ? '：' + error.message : ''));
    }
    paint(document.getElementById('admin-content'), context);
  }

  // air-admin.js renderNative 的契约：panel.render(host, ctx) + panel.refresh()。
  function render(host, context) {
    paint(host, context);
    if (plugins == null) void load(context);
  }
  function refresh() {
    plugins = null;
    const host = document.getElementById('admin-content');
    if (host && contextRef) void load(contextRef);
  }

  root.MultiCCAirPlugins = { render, refresh };
})(typeof window !== 'undefined' ? window : globalThis);
