'use strict';

// 每个 Claude 官方账号的专用出口：「CLI → cli-provider-router → /claude-egress →
// 插件出口 → api.anthropic.com」这条本机跳。这里钉住三件事：
//   • 路由字符串两侧（spawn 侧与 HTTP 侧）解析一致；
//   • 绑定缺失/插件缺失时给出可行动的报错，而不是含糊的 502；
//   • 真正转发时用的是**这个账号**的凭据，并且确实经插件给的代理出去。

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const claudeEgressRoute = require('../src/providers/claude-egress-route');
const { createClaudeEgressForwarder, mergeBeta } = require('../src/claude-auth/egress-forwarder');

const PROVIDER_ID = 'claude-official-aaaaaaaaaaaaaaaa';
const BINDING = { pluginId: 'chrome-proxy-launcher', profileId: 'us-home' };

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

// A real (if minimal) forward proxy: absolute-form requests carry the target in
// the request line, so relaying them by URL is enough for the http case.
function startProxy(seen) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        const target = new URL(req.url);
        const upstream = http.request({
          hostname: target.hostname, port: target.port, path: target.pathname + target.search,
          method: req.method, headers: req.headers,
        }, (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502); res.end(); });
        upstream.end(body);
      });
    });
    listen(server).then(port => resolve({ server, port }));
  });
}

function startUpstream(seen) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_test' });
        res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }] }));
      });
    });
    listen(server).then(port => resolve({ server, port }));
  });
}

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (response) => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function mountForwarder(options) {
  const forwarder = createClaudeEgressForwarder({
    logger: { warn() {}, info() {}, error() {} },
    ...options,
  });
  const app = express();
  forwarder.mount(app, { port: 4321 });
  const server = http.createServer(app);
  const port = await listen(server);
  return { forwarder, server, port };
}

test('the claude-egress URL shape round-trips between spawn and HTTP sides', () => {
  claudeEgressRoute.setPort(4321);
  assert.equal(claudeEgressRoute.baseUrlFor(PROVIDER_ID),
    `http://127.0.0.1:4321/claude-egress/${PROVIDER_ID}`);
  assert.deepEqual(claudeEgressRoute.parseRequestPath(`/${PROVIDER_ID}/v1/messages?beta=true`),
    { providerId: PROVIDER_ID, path: '/v1/messages', query: '?beta=true' });
  assert.equal(claudeEgressRoute.parseRequestPath('/'), null);
  assert.equal(claudeEgressRoute.parseRequestPath('/../etc/passwd'), null, 'path traversal is not a provider id');
});

test('the OAuth beta is merged, never duplicated or dropped', () => {
  assert.equal(mergeBeta(undefined), 'oauth-2025-04-20');
  assert.equal(mergeBeta('claude-code-20250219'), 'claude-code-20250219,oauth-2025-04-20');
  assert.equal(mergeBeta('oauth-2025-04-20,claude-code-20250219'), 'oauth-2025-04-20,claude-code-20250219',
    'an existing OAuth beta is not added twice');
});

test('a bound account is forwarded through the plugin egress with its own credential', async (t) => {
  const proxySeen = [];
  const upstreamSeen = [];
  const proxy = await startProxy(proxySeen);
  const upstream = await startUpstream(upstreamSeen);
  t.after(() => { void close(proxy.server); void close(upstream.server); });

  const provider = {
    id: PROVIDER_ID, appType: 'claude',
    settingsConfig: { env: {}, officialAccount: { id: 'aaaaaaaaaaaaaaaa' } },
    egressBinding: BINDING,
  };
  const credentialArgs = [];
  const mounted = await mountForwarder({
    getProvider: (appType, id) => (id === PROVIDER_ID ? provider : null),
    readCredential: async (arg) => { credentialArgs.push(arg); return { token: 'acct-token' }; },
    runPluginCommand: async (id, command, input) => {
      assert.equal(id, 'chrome-proxy-launcher');
      assert.equal(command, 'egress');
      assert.equal(input.id, 'us-home');
      return { status: 200, payload: { proxyUrl: `http://127.0.0.1:${proxy.port}`, kind: 'core' } };
    },
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
  });
  t.after(() => { void close(mounted.server); });

  const response = await post(mounted.port, `/claude-egress/${PROVIDER_ID}/v1/messages?beta=true`,
    { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] },
    { authorization: 'Bearer cli-virtual-token', 'x-api-key': 'cli-key', 'anthropic-beta': 'claude-code-20250219' });

  assert.equal(response.status, 200);
  assert.equal(response.json.type, 'message');
  assert.equal(response.headers['request-id'], 'req_test', 'upstream response headers come back intact');

  assert.deepEqual(credentialArgs, [{
    provider, providerId: PROVIDER_ID, accountId: 'aaaaaaaaaaaaaaaa', keychainService: 'Claude Code-credentials',
  }]);
  assert.equal(proxySeen.length, 1, 'the request went through the plugin proxy');
  assert.equal(upstreamSeen.length, 1);
  const sent = upstreamSeen[0];
  assert.equal(sent.url, '/v1/messages?beta=true');
  assert.equal(sent.headers.authorization, 'Bearer acct-token', 'the account credential replaces the CLI\'s');
  assert.equal(sent.headers['x-api-key'], undefined, 'the CLI key never reaches Anthropic');
  assert.equal(sent.headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20');
  assert.deepEqual(JSON.parse(sent.body), { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] });
});

test('an uninstalled plugin fails with an actionable message, not a bare 502', async (t) => {
  const mounted = await mountForwarder({
    getProvider: () => ({
      id: PROVIDER_ID, appType: 'claude',
      settingsConfig: { env: {}, officialAccount: { id: 'aaaaaaaaaaaaaaaa' } },
      egressBinding: BINDING,
    }),
    readCredential: async () => ({ token: 'acct-token' }),
    runPluginCommand: async () => ({ status: 404, payload: { error: '插件 chrome-proxy-launcher 不存在' } }),
  });
  t.after(() => { void close(mounted.server); });

  const response = await post(mounted.port, `/claude-egress/${PROVIDER_ID}/v1/messages`, {});
  assert.equal(response.status, 400);
  assert.equal(response.json.error.type, 'PLUGIN_MISSING');
  assert.match(response.json.error.message, /未安装「Chrome 隔离出口启动器」插件/);
});

test('an entry without a binding never rides the hop', async (t) => {
  let commandCalls = 0;
  const mounted = await mountForwarder({
    getProvider: () => ({ id: PROVIDER_ID, appType: 'claude', settingsConfig: { env: {} } }),
    readCredential: async () => ({ token: 'acct-token' }),
    runPluginCommand: async () => { commandCalls++; return { status: 200, payload: { proxyUrl: 'http://127.0.0.1:1' } }; },
  });
  t.after(() => { void close(mounted.server); });

  const response = await post(mounted.port, `/claude-egress/${PROVIDER_ID}/v1/messages`, {});
  assert.equal(response.status, 400);
  assert.equal(response.json.error.type, 'CLAUDE_EGRESS_UNBOUND');
  assert.equal(commandCalls, 0);
});

test('only loopback callers are served — this hop must never become an open proxy', async () => {
  const forwarder = createClaudeEgressForwarder({
    getProvider: () => ({ id: PROVIDER_ID, appType: 'claude', settingsConfig: { env: {} }, egressBinding: BINDING }),
    readCredential: async () => ({ token: 'acct-token' }),
    runPluginCommand: async () => ({ status: 200, payload: { proxyUrl: 'http://127.0.0.1:1' } }),
  });
  const calls = [];
  const res = {
    headersSent: false,
    writeHead(status, headers) { calls.push({ status, headers }); this.headersSent = true; return this; },
    end(body) { calls.push({ body }); },
    destroy() {},
  };
  await forwarder.handle({
    socket: { remoteAddress: '10.1.2.3' },
    url: `/${PROVIDER_ID}/v1/messages`,
    method: 'POST',
    headers: {},
    on() {},
    pipe() {},
  }, res);
  assert.equal(calls[0].status, 403);
  assert.equal(JSON.parse(calls[1].body).error.type, 'CLAUDE_EGRESS_FORBIDDEN');
});
