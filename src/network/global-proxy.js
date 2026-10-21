'use strict';

const http = require('node:http');
const https = require('node:https');
const { createOutbound } = require('./outbound');
const { parseMacSystemProxy, resolveProxyConfig, cidrToRange } = require('./proxy-policy');
function resolveProxyEnv(env, system) {
  const config = resolveProxyConfig(env, system);
  return config.httpProxy || config.httpsProxy ? {
    HTTP_PROXY: config.httpProxy, HTTPS_PROXY: config.httpsProxy,
    NO_PROXY: config.noProxy.join(','),
  } : null;
}

// Requests await discovery themselves, even before startup initialization ends.
// This compatibility layer works without Node's newer setGlobalProxyFromEnv API.
function installGlobalProxy(options = {}) {
  const shared = Object.keys(options).length ? createOutbound(options) : require('./outbound');
  const policy = shared.policy;
  const log = options.log || (message => console.log(`[multicc] ${message}`));
  const previous = { fetch: globalThis.fetch, http: http.globalAgent, https: https.globalAgent };
  if (!options.apply) {
    globalThis.fetch = shared.outboundFetch;
    http.globalAgent = shared.outboundAgent;
    https.globalAgent = shared.outboundAgent;
  }
  let timer, lastKey;
  async function refresh() {
    policy.invalidate();
    const config = await policy.configuration();
    const env = config.httpProxy || config.httpsProxy ? {
      HTTP_PROXY: config.httpProxy, HTTPS_PROXY: config.httpsProxy, NO_PROXY: config.noProxy.join(','),
    } : null;
    const key = JSON.stringify(env);
    if (key !== lastKey) {
      lastKey = key;
      options.apply?.(env);
      log(env ? '出站请求已使用统一代理配置' : '出站请求未配置代理');
    }
    return env;
  }
  // Startup reporting never grants permission for requests to bypass policy.
  const report = error => { log(`代理配置读取失败，外部请求将拒绝发送：${error.message}`); return null; };
  const ready = refresh().catch(report);
  if (options.refresh !== false) {
    timer = setInterval(() => { refresh().catch(report); }, options.refreshMs || 60000);
    timer.unref?.();
  }
  return { ready, refresh, stop() {
    clearInterval(timer);
    if (!options.apply) {
      if (globalThis.fetch === shared.outboundFetch) globalThis.fetch = previous.fetch;
      if (http.globalAgent === shared.outboundAgent) http.globalAgent = previous.http;
      if (https.globalAgent === shared.outboundAgent) https.globalAgent = previous.https;
    }
  } };
}
module.exports = { installGlobalProxy, resolveProxyEnv, parseMacSystemProxy, cidrToRange };
