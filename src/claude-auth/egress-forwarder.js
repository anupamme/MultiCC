'use strict';

// 每个 Claude 官方账号可以绑一条专用出口 —— 出口本身是「Chrome 隔离出口启动器」
// 插件里的一个身份（本机 VPN 端口 / http(s)・socks5 代理 / 订阅节点）。一个账号
// 绑一个身份，账号之间就不再共用同一个公网 IP。
//
// 为什么要在本机多一跳：cli-provider-router（CPR）的 Claude 代理用裸
// http/https.request 拨上游，没有 agent 注入口，出口无法塞进 CPR 内部。于是
// providers/core.js 的 claudeRoutingProviderView 把这条线路的 baseUrl 指到这里：
//
//   CLI → /claude-proxy/<providerId>/<sid>   （CPR：改写、记账、限流）
//       → /claude-egress/<providerId>/…      （本文件：注入该账号的 OAuth）
//       → <插件出口> → https://api.anthropic.com
//
// 绑定只存在于官方账号条目上（provider.egressBinding，见 providers.updateProvider），
// 所以这里也只服务官方账号：别的线路没有绑定，永远走不到这条路。
//
// 失败必须可行动：插件没安装就直说「未安装…插件」，而不是让 CLI 里出现一句含糊的
// 502。出口地址**不缓存**：插件 `egress` 是幂等的（内核/中继活着就复用），一次
// 调用只是读几个 pid 文件；缓存下来反而会让「改了出口却还在走旧 IP」成为可能
// —— 那正是这个功能最不能出的错。并发解析用 singleflight 合并，冷启内核不会
// 因为同一账号的并发请求被拉起两次。

const http = require('http');
const https = require('https');
const { officialAccountIdFromProvider } = require('../official-accounts');
const claudeEgressRoute = require('../providers/claude-egress-route');
const { createPluginsRoutes } = require('../routes/plugins');

const PLUGIN_ID = 'chrome-proxy-launcher';
const PLUGIN_NAME = 'Chrome 隔离出口启动器';
// 与 CPR 一致：官方账号的 token 走账号文件，终端登录（claude-official 别名）
// 走本机钥匙串里的同一条记录。
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const UPSTREAM = 'https://api.anthropic.com';
// 官方分支本来由 CPR 加的 beta 头；换成通用路径后由这里补上，否则 Anthropic
// 会把 OAuth 令牌当成普通 API key 拒绝。
const OAUTH_BETA = 'oauth-2025-04-20';
const AGENT_CACHE_MAX = 16;
const REQUEST_HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-api-key',
];
const RESPONSE_HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
];

function withoutHeaders(source, names) {
  const drop = new Set(names);
  const out = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (!drop.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

function mergeBeta(value) {
  const list = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  if (!list.includes(OAUTH_BETA)) list.push(OAUTH_BETA);
  return list.join(',');
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// 官方账号线路的令牌，口径与 CPR 的官方分支逐字一致：带账号标记的读账号
// 自己的凭据（过期时由 accounts-refresh 的 CLI 续期），终端别名读钥匙串。
async function readAccountCredential(provider, providerId, readCredential) {
  const accountId = officialAccountIdFromProvider(provider);
  if (!accountId && providerId !== 'claude-official') {
    return { error: '专用出口只支持 Claude 官方账号线路' };
  }
  const credential = accountId
    ? await readCredential({ provider, providerId, accountId, keychainService: KEYCHAIN_SERVICE })
    : await readCredential(KEYCHAIN_SERVICE);
  if (!credential || !credential.token) {
    return { error: `账号凭据不可用（${(credential && credential.reason) || '未知原因'}），请重新登录这个账号` };
  }
  return { token: credential.token };
}

function createClaudeEgressForwarder(options = {}) {
  const getProvider = options.getProvider;
  const readCredential = options.readCredential;
  const logger = options.logger || { warn() {}, info() {}, error() {} };
  // 插件通道：默认自己建一个（同一份 plugins/ 目录，无状态），测试可注入。
  const runPluginCommand = options.runPluginCommand || ((id, command, input) => createPluginsRoutes({
    pluginsDir: require('path').join(__dirname, '..', '..', 'plugins'),
    platform: process.platform, arch: process.arch, logger,
  }).runPluginCommand(id, command, input));
  const upstreamBase = options.upstreamBaseUrl || UPSTREAM;

  const resolving = new Map(); // 同一出口的并发解析只跑一次
  const agents = new Map();    // 出口 URL → proxy-agent 实例

  function agentFor(url) {
    let agent = agents.get(url);
    if (agent) return agent;
    // 懒 require：没有绑定专用出口的安装不该为这个依赖付出启动成本。
    const { ProxyAgent } = require('proxy-agent');
    agent = new ProxyAgent({ getProxyForUrl: () => url });
    agents.set(url, agent);
    while (agents.size > AGENT_CACHE_MAX) agents.delete(agents.keys().next().value);
    return agent;
  }

  function describeFailure(result) {
    const error = String((result && result.payload && result.payload.error) || '未知原因');
    if (result && result.status === 404) {
      return {
        status: 400, code: 'PLUGIN_MISSING',
        message: `未安装「${PLUGIN_NAME}」插件，无法使用专用出口。请先在 Air → 资料与插件里安装它，`
          + '再在插件里建一个身份（填好出口）作为这个账号的专用出口。',
      };
    }
    if (result && result.status === 503) {
      return { status: 400, code: 'PLUGIN_UNAVAILABLE', message: `「${PLUGIN_NAME}」插件不可用：${error}` };
    }
    return { status: 400, code: 'EGRESS_UNAVAILABLE', message: `专用出口不可用：${error}` };
  }

  async function resolveTarget(binding) {
    const key = `${binding.pluginId}:${binding.profileId}`;
    let pending = resolving.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => runPluginCommand(binding.pluginId, 'egress', { id: binding.profileId }))
        .then((result) => {
          const data = result && result.status === 200 ? result.payload : null;
          const url = data && typeof data.proxyUrl === 'string' ? data.proxyUrl.trim() : '';
          if (!url) {
            const failure = describeFailure(result);
            throw Object.assign(new Error(failure.message), failure);
          }
          return url;
        })
        .finally(() => resolving.delete(key));
      resolving.set(key, pending);
    }
    return { key, url: await pending };
  }

  function reply(res, status, code, message) {
    if (res.headersSent) {
      try { res.destroy(); } catch (_) { /* already gone */ }
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: code, message } }));
  }

  // 一次转发：请求体原样送到 api.anthropic.com，响应（含 SSE 流与 ratelimit
  // 头）原样回流。失败分两类 —— 拿到响应头之后的失败只能断开（已经无法改口），
  // 之前的失败标记 retryable，由调用方换个出口再试一次。
  function relay(req, res, context) {
    return new Promise((resolve, reject) => {
      const target = new URL(upstreamBase);
      const transport = target.protocol === 'https:' ? https : http;
      const headers = withoutHeaders(req.headers, REQUEST_HOP_HEADERS);
      headers.host = target.host;
      headers.authorization = `Bearer ${context.token}`;
      headers['anthropic-beta'] = mergeBeta(headers['anthropic-beta']);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
      let upstream;
      try {
        upstream = transport.request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path: context.path,
          headers,
          agent: agentFor(context.url),
        }, (response) => {
          res.writeHead(response.statusCode || 502, withoutHeaders(response.headers, RESPONSE_HOP_HEADERS));
          response.pipe(res);
          response.on('error', () => { try { res.destroy(); } catch (_) { /* gone */ } });
          response.on('end', resolve);
        });
      } catch (error) {
        reject(Object.assign(error, { retryable: true }));
        return;
      }
      upstream.on('error', (error) => {
        if (res.headersSent) {
          try { res.destroy(); } catch (_) { /* gone */ }
          resolve();
          return;
        }
        reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { retryable: true }));
      });
      const abort = () => { try { upstream.destroy(); } catch (_) { /* gone */ } };
      req.on('aborted', abort);
      req.on('error', abort);
      res.on('close', abort);
      req.pipe(upstream);
    });
  }

  async function handle(req, res) {
    // 只收本机：CPR 与 CLI 都在 127.0.0.1 上，外来的 peer 一律拒绝 —— 否则
    // 这就是一个用账号令牌当免费出口的开放代理。
    if (!isLoopback(req.socket && req.socket.remoteAddress)) {
      return reply(res, 403, 'CLAUDE_EGRESS_FORBIDDEN', 'claude-egress 只接受本机请求');
    }
    const parsed = claudeEgressRoute.parseRequestPath(req.url);
    if (!parsed || parsed.path === '/') {
      return reply(res, 404, 'CLAUDE_EGRESS_PATH', 'claude-egress 路径无效');
    }
    const providerId = parsed.providerId;
    let provider = null;
    try { provider = getProvider('claude', providerId); } catch (_) { provider = null; }
    if (!provider) return reply(res, 404, 'CLAUDE_EGRESS_PROVIDER', `线路 ${providerId} 不存在`);
    const binding = provider.egressBinding;
    if (!binding || typeof binding.pluginId !== 'string' || typeof binding.profileId !== 'string'
      || !binding.pluginId || !binding.profileId) {
      return reply(res, 400, 'CLAUDE_EGRESS_UNBOUND', '这条线路没有绑定专用出口');
    }

    let credential;
    try {
      credential = await readAccountCredential(provider, providerId, readCredential);
    } catch (error) {
      return reply(res, 502, 'CLAUDE_EGRESS_CREDENTIAL', `读取账号凭据失败：${error.message}`);
    }
    if (credential.error) return reply(res, 502, 'CLAUDE_EGRESS_CREDENTIAL', credential.error);

    const path = parsed.path + parsed.query;
    let target;
    try { target = await resolveTarget(binding); }
    catch (failure) { return reply(res, failure.status || 400, failure.code || 'EGRESS_UNAVAILABLE', failure.message); }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await relay(req, res, { token: credential.token, path, url: target.url });
        return;
      } catch (error) {
        if (res.headersSent || attempt > 0) {
          return reply(res, 502, 'CLAUDE_EGRESS_UPSTREAM', `经专用出口连接 Anthropic 失败：${error.message}`);
        }
        // 上一次解析拿到的出口可能已经失活（中继 30 分钟无流量自杀、内核被 stop）。
        // 重新解析一次；插件自己会复用活着的组件、重起死掉的。
        logger.warn('claude_egress_target_retry', { providerId, profileId: binding.profileId, error: error.message });
        try { target = await resolveTarget(binding); }
        catch (failure) { return reply(res, failure.status || 400, failure.code || 'EGRESS_UNAVAILABLE', failure.message); }
      }
    }
  }

  // 必须挂在 express.json() 之前：请求体要原样流到上游，不能被解析消耗。
  function mount(app, mountOptions = {}) {
    claudeEgressRoute.setPort(mountOptions.port);
    app.use(claudeEgressRoute.PREFIX, (req, res) => {
      handle(req, res).catch((error) => {
        logger.warn('claude_egress_failed', { error: error && error.message });
        reply(res, 502, 'CLAUDE_EGRESS_FAILED', `专用出口转发失败：${(error && error.message) || '未知错误'}`);
      });
    });
  }

  return { mount, handle };
}

module.exports = { createClaudeEgressForwarder, mergeBeta, REQUEST_HOP_HEADERS, RESPONSE_HOP_HEADERS };
