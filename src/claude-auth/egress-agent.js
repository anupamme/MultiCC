'use strict';

// 每个 Claude 官方账号可以绑一条专用出口 —— 出口本身是「Chrome 隔离出口启动器」
// 插件里的一个身份（本机 VPN 端口 / http・socks5 代理 / 订阅节点）。一个账号绑
// 一个身份，账号之间就不再共用同一个公网 IP。
//
// 出口由 CPR 自己走：cli-provider-router ≥0.5.2 的 claude 代理在拨上游前问宿主
// `resolveUpstreamAgent(context)`，这里按 context.provider.egressBinding 返回一个
// 走该身份代理的 agent。令牌注入、官方分支、401 后换令牌重发都还在 CPR 里，
// 这里只决定「从哪个出口出去」：
//
//   CLI → /claude-proxy/<账号>（CPR：改写、记账、注入该账号 OAuth）
//       → <插件出口> → https://api.anthropic.com
//
// 绑定只存在于官方账号条目上（provider.egressBinding，见 providers.updateProvider）；
// 没有绑定的线路返回 undefined，CPR 照旧直连。
//
// 失败必须可行动、且绝不回落直连：插件没装就直说「未安装…插件」，CPR 把它原样
// 作为错误回给 CLI。出口地址**不缓存**：插件 `egress` 是幂等的（内核/中继活着就
// 复用、死了就重起），一次调用只是读几个 pid 文件；缓存反而会让「改了出口却还
// 在走旧 IP」成为可能 —— 那正是这个功能最不能出的错。每个请求拨号前现解析，
// 所以中继 30 分钟无流量自退也只会在下一次请求时被拉起。并发解析用 singleflight
// 合并，冷启内核不会因为同一账号的并发请求被拉起两次。

const path = require('path');
const { createPluginsRoutes } = require('../routes/plugins');

const PLUGIN_ID = 'chrome-proxy-launcher';
const PLUGIN_NAME = 'Chrome 隔离出口启动器';
const AGENT_CACHE_MAX = 16;

function bindingOf(provider) {
  const binding = provider && provider.egressBinding;
  if (!binding || typeof binding !== 'object') return null;
  if (typeof binding.pluginId !== 'string' || !binding.pluginId) return null;
  if (typeof binding.profileId !== 'string' || !binding.profileId) return null;
  return binding;
}

function describeFailure(result) {
  const error = String((result && result.payload && result.payload.error) || '未知原因');
  if (result && result.status === 404) {
    return {
      statusCode: 400, code: 'PLUGIN_MISSING',
      message: `未安装「${PLUGIN_NAME}」插件，无法使用专用出口。请先在 Air → 资料与插件里安装它，`
        + '再在插件里建一个身份（填好出口）作为这个账号的专用出口。',
    };
  }
  if (result && result.status === 503) {
    return { statusCode: 400, code: 'PLUGIN_UNAVAILABLE', message: `「${PLUGIN_NAME}」插件不可用：${error}` };
  }
  return { statusCode: 400, code: 'EGRESS_UNAVAILABLE', message: `专用出口不可用：${error}` };
}

function createClaudeEgressAgentResolver(options = {}) {
  const logger = options.logger || { warn() {}, info() {}, error() {} };
  // 插件通道：默认自己建一个（同一份 plugins/ 目录，无状态），测试可注入。
  const runPluginCommand = options.runPluginCommand || ((id, command, input) => createPluginsRoutes({
    pluginsDir: path.join(__dirname, '..', '..', 'plugins'),
    platform: process.platform, arch: process.arch, logger,
  }).runPluginCommand(id, command, input));
  // 测试可注入；默认懒 require：没有绑定专用出口的安装不该为这个依赖付出启动成本。
  const createAgent = options.createAgent || ((url) => {
    const { ProxyAgent } = require('proxy-agent');
    return new ProxyAgent({ getProxyForUrl: () => url });
  });

  const resolving = new Map(); // 同一出口的并发解析只跑一次
  const agents = new Map();    // 出口 URL → agent（只按地址复用连接池，不缓存解析结果）

  function agentFor(url) {
    let agent = agents.get(url);
    if (agent) return agent;
    agent = createAgent(url);
    agents.set(url, agent);
    while (agents.size > AGENT_CACHE_MAX) {
      const oldest = agents.keys().next().value;
      const stale = agents.get(oldest);
      agents.delete(oldest);
      try { if (stale && typeof stale.destroy === 'function') stale.destroy(); } catch (_) { /* gone */ }
    }
    return agent;
  }

  function resolveProxyUrl(binding) {
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
    return pending;
  }

  // CPR 的 resolveUpstreamAgent。返回 undefined = 直连；抛错 = 拨号前失败
  // （statusCode / code 由 CPR 带回给 CLI）。
  async function resolveUpstreamAgent(context = {}) {
    const binding = bindingOf(context.provider);
    if (!binding) return undefined;
    try {
      return agentFor(await resolveProxyUrl(binding));
    } catch (error) {
      logger.warn('claude_egress_unavailable', {
        providerId: context.providerId, profileId: binding.profileId, code: error.code, error: error.message,
      });
      throw error;
    }
  }

  return { resolveUpstreamAgent };
}

// 旧版 CPR 不认钩子时会把它**静默忽略**（supported 由 providerRouterRuntime
// .routerSupports('upstreamAgent') 给出）。兜底：绑了专用出口的账号在读令牌这一步
// 就失败，CPR 回「official OAuth unavailable — <原因>」，而不是悄悄从本机 IP 发出去。
function guardCredentialReader(readCredential, { supported }) {
  if (supported) return readCredential;
  return async (arg) => {
    if (arg && typeof arg === 'object' && bindingOf(arg.provider)) {
      return {
        token: null,
        reason: '这个账号绑定了专用出口，但当前 cli-provider-router 版本过旧、不支持按账号出口；'
          + '请在 multicc 目录执行 npm install 后重启服务',
      };
    }
    return readCredential(arg);
  };
}

module.exports = {
  createClaudeEgressAgentResolver,
  guardCredentialReader,
  describeFailure,
  PLUGIN_ID,
  PLUGIN_NAME,
};
