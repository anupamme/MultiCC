'use strict';

/* 外部访问根域候选 —— 「分享链接」「借道链接」这类要交给别人在外面打开的地址，
   都得先回答同一个问题：用哪个根域拼这条链接。答案在这一个地方算。

   三个来源：当前页面地址、/api/server-info 的局域网地址、/api/settings/tunnel
   里已配置或已探活的穿透地址（tailscale / phddns / natapp / cpolar / sakurafrp）。

   每一项给出 url（照原样，可能带路径，借道链接沿用这个）、origin（剥掉路径的
   根域，拼 /share/<token> 这种以根为基准的链接要用它）和 scope（local / lan /
   public，说明外面的人打不打得开，对话框据此挑默认值）。

   尽力而为：任何一处拿不到就少几个选项，绝不抛错 —— 选根域的对话框不能因为某个
   探活接口不通就打不开。 */

(function installMulticcBaseUrlOptions(root) {
  const TUNNELS = ['tailscale', 'phddns', 'natapp', 'cpolar', 'sakurafrp'];

  // 这个地址外面的人打不打得开。只按主机名判断，不解析 DNS、不发请求。
  function scopeOf(origin) {
    let host = '';
    try { host = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch (_) { return 'local'; }
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '::' || host === '0.0.0.0' || /^127\./.test(host)) return 'local';
    if (/^192\.168\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host)) return 'lan';
    if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return 'lan';
    if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || /^(?:fc|fd)[\da-f]{2}:|^fe[89ab][\da-f]:/i.test(host)) return 'lan';
    if (/\.(?:local|lan|internal|home|localdomain)$/.test(host) || (!host.includes('.') && !host.includes(':'))) return 'lan';
    return 'public';
  }

  function normalize(raw) {
    const url = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) return null;
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // A URL with an embedded credential is not an address anyone hands to a
    // recipient, and it would leak the credential into the shared link.
    if (parsed.username || parsed.password) return null;
    return { url, origin: parsed.origin, scope: scopeOf(parsed.origin) };
  }

  async function defaultJson(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // 最前面那项是「当前页面地址」：调用方多半在本地开着管理页，这一项通常是
  // 127.0.0.1；需要给外部人用的调用方应该按 scope 自己挑，不要直接用第 0 项。
  async function multiccBaseUrlOptions(options = {}) {
    const read = typeof options.json === 'function' ? options.json : defaultJson;
    const seen = new Set();
    const list = [];
    const push = (raw, label) => {
      const candidate = normalize(raw);
      if (!candidate || seen.has(candidate.url)) return;
      seen.add(candidate.url);
      list.push({ ...candidate, label });
    };

    try { push(location.origin, '当前页面地址'); } catch (_) {}

    let info = null;
    try { info = await read('/api/server-info'); } catch (_) {}
    if (info) {
      const lanUrls = Array.isArray(info.lanUrls) ? info.lanUrls : [];
      if (lanUrls.length) lanUrls.forEach((url, index) => push(url, lanUrls.length > 1 ? `局域网 ${index + 1}` : '局域网'));
      else if (info.lanAvailable !== false && info.ip) push(`http://${info.ip}:${info.port || 3000}`, '局域网');
    }

    let tunnel = null;
    try { tunnel = await read('/api/settings/tunnel'); } catch (_) {}
    if (tunnel) {
      const config = tunnel.config || {};
      const providers = tunnel.providers || {};
      for (const name of TUNNELS) {
        const publicUrl = providers[name] && providers[name].publicUrl;
        if (publicUrl) push(publicUrl, `公网(${name})`);
        const configUrl = config[name] && config[name].url;
        if (configUrl) push(configUrl, `穿透(${name})`);
      }
    }
    return list;
  }

  // 分享链接以根为基准拼 /share/<token>，同一台机器既在页面上打开又配了穿透时
  // 会出现同根域的多种写法（带路径的、带尾斜杠的），按根域去重后再给人选。
  async function multiccBaseUrlChoices(options) {
    const list = await multiccBaseUrlOptions(options);
    const seen = new Set();
    return list.filter((item) => {
      if (seen.has(item.origin)) return false;
      seen.add(item.origin);
      return true;
    });
  }

  // 该预选哪一个：公网 > 局域网 > 本机。列表里第一项永远是「当前页面地址」，
  // 它多半是 127.0.0.1 —— 直接取第一项就是把打不开的链接递出去。
  function multiccPreferredBaseUrl(list) {
    const rank = { public: 0, lan: 1, local: 2 };
    let best = null;
    for (const item of Array.isArray(list) ? list : []) {
      if (!best || rank[item.scope] < rank[best.scope]) best = item;
    }
    return best;
  }

  function multiccMountExternalAccessHint(host, url) {
    if (!host) return;
    const scope = url ? scopeOf(url) : null;
    const key = scope === 'local' ? 'externalAccessLocal' : scope === 'lan' ? 'externalAccessLan' : 'externalAccessHint';
    const fallback = {
      externalAccessLocal: '当前地址只有本机能打开。分享给外网用户前，请先设置外网访问并选择外网地址。',
      externalAccessLan: '当前地址仅适用于同一内网或已连接的专用网络。分享给外网用户前，请先设置外网访问并选择外网地址。',
      externalAccessHint: '需要从外网打开分享链接或连接本机时，请先配置可访问的外网地址，并确认接收方能打开。',
      externalAccessSetup: '设置外网访问',
    };
    const tr = name => typeof root.t === 'function' ? root.t(name) : fallback[name];
    host.replaceChildren(document.createTextNode(tr(key) + ' '));
    const link = document.createElement('a');
    link.href = '/air?view=tunnel'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = tr('externalAccessSetup'); link.style.color = 'inherit';
    host.appendChild(link);
  }

  // 把候选地址填进一个 <select> 并预选该预选的那一个 —— 分享对话框要的就是这个，
  // 而它同样是「一份实现」：整个会话的分享和选中消息的分享用的是同一个下拉。
  //
  // 候选来自异步探活接口，所以对话框先开、下拉后填；填好之前保持 disabled，
  // 免得手快点下去生成一条写死 127.0.0.1 的链接。select.dataset.hintId 指向一个
  // 提示元素：只有在没有穿透地址、只剩下本机时，用它说清这条链接发出去别人打不开。
  async function multiccMountBaseUrlSelect(select, options) {
    let choices = [];
    try { choices = await multiccBaseUrlChoices(options); } catch (_) {}
    if (!select || !select.isConnected) return [];
    const preferred = multiccPreferredBaseUrl(choices);
    select.innerHTML = '';
    const shown = choices.length ? choices : [{ origin: location.origin, label: '当前页面地址', scope: 'local' }];
    for (const item of shown) {
      const option = document.createElement('option');
      option.value = item.origin;
      option.textContent = `${item.label} · ${item.origin}`;
      if (preferred && item.origin === preferred.origin) option.selected = true;
      select.appendChild(option);
    }
    select.disabled = false;
    const hint = select.dataset.hintId ? document.getElementById(select.dataset.hintId) : null;
    const updateHint = () => multiccMountExternalAccessHint(hint, select.value);
    updateHint();
    select.addEventListener('change', updateHint);
    return shown;
  }

  root.multiccBaseUrlOptions = multiccBaseUrlOptions;
  root.multiccBaseUrlChoices = multiccBaseUrlChoices;
  root.multiccPreferredBaseUrl = multiccPreferredBaseUrl;
  root.multiccMountBaseUrlSelect = multiccMountBaseUrlSelect;
  root.multiccMountExternalAccessHint = multiccMountExternalAccessHint;
})(typeof window !== 'undefined' ? window : globalThis);
