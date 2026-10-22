'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { managedRoute, createRouteRelay } = require('../src/chat/claude-sdk-route');

test('relay requires its capability token and only reaches the bound local route', async t => {
  for (const url of ['https://127.0.0.1/claude-proxy/p/s', 'http://example.org/claude-proxy/p/s',
    'http://user:pass@127.0.0.1/claude-proxy/p/s', 'http://127.0.0.1/claude-proxy/p/s?x=y']) {
    assert.equal(managedRoute({ ANTHROPIC_BASE_URL: url }), null);
  }
  const relay = await createRouteRelay({ logger: null });
  t.after(() => relay.close());
  assert.equal((await fetch(`${relay.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST' })).status, 401);
  const headers = { authorization: `Bearer ${relay.env.ANTHROPIC_AUTH_TOKEN}` };
  for (const [method, path] of [['GET', '/v1/messages'], ['POST', '/api/internal']]) {
    assert.equal((await fetch(relay.env.ANTHROPIC_BASE_URL + path, { method, headers })).status, 503);
  }
  // fetch normalizes dot segments, so send the literal path to prove the relay refuses it.
  const traversal = await new Promise((resolve, reject) => {
    const port = Number(new URL(relay.env.ANTHROPIC_BASE_URL).port);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST',
      path: '/v1/messages/../../admin', headers }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject); req.end('{}');
  });
  assert.equal(traversal, 400);
  assert.equal((await fetch(relay.env.ANTHROPIC_BASE_URL + '/api/hello', { method: 'HEAD', headers })).status, 200);
});

// A CLI build may call endpoints this relay has never heard of. Forwarding them
// is what keeps the CLI from turning a local 404 into "There's an issue with the
// selected model (...)".
test('unknown paths and methods are forwarded verbatim instead of 404', async t => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => { received.push({ method: req.method, url: req.url }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const warnings = [];
  const relay = await createRouteRelay({ logger: { warn: (...args) => warnings.push(args.join(' ')) } });
  t.after(() => relay.close());
  relay.bind({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}/claude-proxy/p/s`,
    ANTHROPIC_AUTH_TOKEN: 'route' });
  const headers = { authorization: `Bearer ${relay.env.ANTHROPIC_AUTH_TOKEN}` };
  for (const [method, path] of [['POST', '/v1/messages/cache_touch'], ['GET', '/v1/models'],
    ['POST', '/v1/messages/batches?beta=true']]) {
    assert.equal((await fetch(relay.env.ANTHROPIC_BASE_URL + path, { method, headers })).status, 200);
    assert.equal((await fetch(relay.env.ANTHROPIC_BASE_URL + path, { method, headers })).status, 200);
  }
  assert.equal(received.length, 6);
  assert.deepEqual(received.filter((_, i) => i % 2 === 0), [
    { method: 'POST', url: '/claude-proxy/p/s/v1/messages/cache_touch' },
    { method: 'GET', url: '/claude-proxy/p/s/v1/models' },
    { method: 'POST', url: '/claude-proxy/p/s/v1/messages/batches?beta=true' },
  ]);
  assert.equal(warnings.length, 3, 'each unusual request is logged once');
});

test('relay pins active requests, replaces auth and preserves SSE bytes and backpressure', async t => {
  const received = [];
  let release, requested;
  const ready = new Promise(resolve => { requested = resolve; });
  const tail = Buffer.from('\ndata: {"type":"message_stop"}\n\n');
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-test-response': 'preserved' });
    res.write(Buffer.from('data: 中文\n'));
    release = () => res.end(tail);
    requested();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const relay = await createRouteRelay();
  t.after(() => relay.close());
  const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}/claude-proxy/provider/old`,
    ANTHROPIC_AUTH_TOKEN: 'old-capability' };
  relay.bind(env);
  const response = fetch(relay.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
    method: 'POST', headers: { authorization: `Bearer ${relay.env.ANTHROPIC_AUTH_TOKEN}`,
      'x-api-key': 'must-not-pass', 'content-type': 'application/json' }, body: '{"stream":true}',
  });
  await ready;
  assert.throws(() => relay.bind({ ...env, ANTHROPIC_AUTH_TOKEN: 'new' }), { code: 'SDK_ROUTE_BUSY' });
  const res = await response;
  release();
  assert.equal(await res.text(), 'data: 中文\n' + tail.toString());
  assert.equal(res.headers.get('x-test-response'), 'preserved');
  await relay.drain();
  assert.equal(received[0].url, '/claude-proxy/provider/old/v1/messages?beta=true');
  assert.equal(received[0].headers.authorization, 'Bearer old-capability');
  assert.equal(received[0].headers['x-api-key'], undefined);
  assert.equal(received[0].body, '{"stream":true}');
  relay.bind({ ...env, ANTHROPIC_AUTH_TOKEN: 'new' });
});

test('closing a relay aborts an unfinished upstream and closes its listener', async t => {
  let started, ended;
  const ready = new Promise(resolve => { started = resolve; });
  const disconnected = new Promise(resolve => { ended = resolve; });
  const upstream = http.createServer((req, res) => {
    req.resume(); res.once('close', ended); started();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const relay = await createRouteRelay();
  t.after(() => relay.close());
  relay.bind({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}/claude-proxy/p/s`, ANTHROPIC_AUTH_TOKEN: 'route' });
  const request = fetch(relay.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST',
    headers: { authorization: `Bearer ${relay.env.ANTHROPIC_AUTH_TOKEN}` }, body: '{}' });
  const failed = assert.rejects(request);
  await ready;
  await assert.rejects(relay.drain(10), { code: 'SDK_ROUTE_BUSY' });
  await relay.close();
  await Promise.all([failed, disconnected]);
  await assert.rejects(fetch(relay.env.ANTHROPIC_BASE_URL));
});
