'use strict';

// Process-wide outbound proxy: every fetch() and http(s).request() MultiCC makes
// follows the user's proxy (explicit env first, else the macOS system proxy), and
// the proxy decides the routing. Loopback / the system exceptions list stay
// direct, so local CLI -> MultiCC traffic never leaves the machine.
//
// Uses Node's own http.setGlobalProxyFromEnv (covers built-in fetch and the
// http/https agents), so no foreign undici dispatcher is mixed into fetch.

const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1', '[::1]'];
const REFRESH_MS = 60000;

// 10.0.0.0/8 -> 10.0.0.0-10.255.255.255 (Node's NO_PROXY speaks ranges, not CIDR).
function cidrToRange(entry) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(entry);
  if (!m) return null;
  const bits = Number(m[5]);
  if (bits < 0 || bits > 32 || m.slice(1, 5).some(o => Number(o) > 255)) return null;
  const ip = m.slice(1, 5).reduce((n, o) => n * 256 + Number(o), 0);
  const size = 2 ** (32 - bits);
  const start = ip - (ip % size);
  const fmt = n => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
  return `${fmt(start)}-${fmt(start + size - 1)}`;
}

function parseMacSystemProxy(text) {
  const value = key => new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'm').exec(text)?.[1];
  const proxy = prefix => {
    if (value(`${prefix}Enable`) !== '1') return '';
    const host = value(`${prefix}Proxy`), port = Number(value(`${prefix}Port`));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  };
  // Node's built-in proxy support is HTTP(S) only: a SOCKS-only setup cannot be
  // honoured, so report it and let the caller warn instead of silently going direct.
  const socksProxy = (() => {
    if (value('SOCKSEnable') !== '1') return '';
    const host = value('SOCKSProxy'), port = Number(value('SOCKSPort'));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    return `socks5://${host.includes(':') ? `[${host}]` : host}:${port}`;
  })();
  const exceptions = [];
  const list = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/.exec(text);
  if (list) {
    for (const line of list[1].split('\n')) {
      const item = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line)?.[1];
      if (!item || item === '<local>') continue; // plain-hostname rule: no NO_PROXY equivalent
      exceptions.push(cidrToRange(item) || item);
    }
  }
  return { httpProxy: proxy('HTTP'), httpsProxy: proxy('HTTPS'), socksProxy, exceptions };
}

// Explicit env wins; otherwise the macOS system proxy; otherwise nothing.
function resolveProxyEnv(env, system) {
  const http_ = env.http_proxy ?? env.HTTP_PROXY;
  const https_ = env.https_proxy ?? env.HTTPS_PROXY;
  const all = env.all_proxy ?? env.ALL_PROXY;
  const hasEnv = http_ !== undefined || https_ !== undefined || all !== undefined;
  let httpProxy, httpsProxy, noProxy = [];
  if (hasEnv) {
    httpProxy = http_ ?? all ?? '';
    httpsProxy = https_ ?? http_ ?? all ?? '';
  } else if (system) {
    ({ httpProxy, httpsProxy } = system);
    noProxy = system.exceptions || [];
  }
  // Only HTTP(S) proxy URLs are usable by Node's proxy support (SOCKS is not).
  const usable = u => (u && /^https?:\/\//i.test(u) ? u : '');
  httpProxy = usable(httpProxy); httpsProxy = usable(httpsProxy);
  // A SOCKS proxy cannot be used by Node: say so rather than pretending the
  // traffic is proxied. Explicit empty env means "direct", so only fall back to
  // the system SOCKS setting when no proxy env is set at all.
  if (!httpProxy && !httpsProxy) {
    const socks = [https_, http_, all].find(u => typeof u === 'string' && /^socks/i.test(u))
      || (!hasEnv && system && system.socksProxy);
    return socks ? { socksOnly: socks } : null;
  }
  const userNoProxy = String(env.no_proxy ?? env.NO_PROXY ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const merged = [...new Set([...ALWAYS_DIRECT, ...userNoProxy, ...noProxy])];
  return { HTTP_PROXY: httpProxy, HTTPS_PROXY: httpsProxy, NO_PROXY: merged.join(',') };
}

async function readMacSystemProxy() {
  const { stdout } = await runFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2000, maxBuffer: 32768 });
  return parseMacSystemProxy(stdout);
}

function installGlobalProxy(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  // setGlobalProxyFromEnv returns a restore fn (back to the prior state); passing
  // {} does NOT reset, so undo the previous install before applying the next.
  let restore = null;
  const apply = options.apply || (typeof http.setGlobalProxyFromEnv === 'function'
    ? cfg => {
        if (restore) { restore(); restore = null; }
        if (cfg) restore = http.setGlobalProxyFromEnv(cfg);
      }
    : null);
  const log = options.log || (msg => console.log(`[multicc] ${msg}`));
  if (!apply) { log('outbound proxy: Node lacks http.setGlobalProxyFromEnv, requests go direct'); return { stop() {} }; }
  const readSystem = options.readSystemProxy || readMacSystemProxy;
  let lastKey = null, timer = null, lastSystem = null;
  // Explicit proxy env wins, so reading the system proxy would be wasted work.
  const hasProxyEnv = () => [env.http_proxy, env.HTTP_PROXY, env.https_proxy, env.HTTPS_PROXY, env.all_proxy, env.ALL_PROXY]
    .some(v => v !== undefined);

  async function refresh() {
    let system = lastSystem;
    if (platform === 'darwin' && !hasProxyEnv()) {
      // A failed read (scutil timeout) keeps the previous settings: falling back
      // to direct would silently bypass the proxy the user is relying on.
      try { system = await readSystem(); lastSystem = system; } catch (_) { system = lastSystem; }
    }
    const cfg = resolveProxyEnv(env, system);
    if (cfg && cfg.socksOnly) {
      const key = `socks:${cfg.socksOnly}`;
      if (key !== lastKey) {
        lastKey = key;
        apply(null);
        log(`outbound proxy: macOS only has a SOCKS proxy (${cfg.socksOnly}); Node cannot use SOCKS — requests go direct. Enable an HTTP proxy or set HTTPS_PROXY.`);
      }
      return null;
    }
    const key = JSON.stringify(cfg);
    if (key === lastKey) return cfg;
    lastKey = key;
    apply(cfg);
    log(cfg ? `outbound proxy: ${cfg.HTTPS_PROXY || cfg.HTTP_PROXY} (no_proxy ${cfg.NO_PROXY})` : 'outbound proxy: direct');
    return cfg;
  }

  const ready = refresh();
  // Re-read settings so toggling a desktop proxy (or editing proxy env) needs no
  // restart. System proxy is read on macOS only; elsewhere the env is re-checked.
  if (options.refresh !== false) {
    timer = setInterval(() => { refresh().catch(() => {}); }, options.refreshMs || REFRESH_MS);
    timer.unref?.();
  }
  return {
    ready,
    refresh,
    stop() { if (timer) clearInterval(timer); if (restore) { restore(); restore = null; } },
  };
}

module.exports = { installGlobalProxy, resolveProxyEnv, parseMacSystemProxy, cidrToRange };
