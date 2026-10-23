#!/usr/bin/env node
'use strict';

// 隔离基准工具：客户端、待测代理、固定上游各自占用独立进程。
// 不读真实供应商、不改宿主环境文件、不挂载管理路由；后端产品逻辑仍取自实际运行时。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const sse = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const digest = value => createHash('sha256').update(value).digest('hex');
const round = n => Math.round(n * 1000) / 1000;
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const median = values => round(quantile(values, 0.5));

const workloads = [
  { name: 'claude-small', protocol: 'claude', inputBytes: 2048, events: 16, textBytes: 64, concurrency: [1, 16], requests: 2000 },
  { name: 'codex-small', protocol: 'codex', inputBytes: 2048, events: 16, textBytes: 64, concurrency: [1, 16], requests: 2000 },
  { name: 'claude-long-context', protocol: 'claude', inputBytes: 1048576, events: 16, textBytes: 64, concurrency: [1, 8], requests: 128 },
  { name: 'codex-long-context', protocol: 'codex', inputBytes: 1048576, events: 16, textBytes: 64, concurrency: [1, 8], requests: 128 },
  { name: 'claude-large-output', protocol: 'claude', inputBytes: 2048, events: 4096, textBytes: 128, concurrency: [1, 8], requests: 128 },
  { name: 'claude-paced-stream', protocol: 'claude', inputBytes: 2048, events: 64, textBytes: 64, intervalMs: 2, concurrency: [1, 8], requests: 16 },
];

function responseBody(spec) {
  if (spec.json) return JSON.stringify(spec.protocol === 'claude'
    ? { content: [{ type: 'text', text: '中文🌏' }], usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 2 } }
    : { output: [], usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 5 } } });
  const parts = [];
  if (spec.protocol === 'claude') parts.push(sse({ type: 'message_start', message: { usage: { input_tokens: 7, cache_read_input_tokens: 2 } } }),
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
  const text = '中文🌏' + 'x'.repeat(spec.textBytes || 64);
  for (let i = 0; i < (spec.events || 4); i++) parts.push(sse(spec.protocol === 'claude'
    ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
    : { type: 'response.output_text.delta', delta: text }));
  if (spec.protocol === 'claude') parts.push(sse({ type: 'message_delta', usage: { output_tokens: 9 } }), sse({ type: 'message_stop' }));
  else parts.push(sse({ type: 'response.completed', response: { id: 'resp_bench', output: [],
    usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 5 } } } }));
  return parts;
}

async function upstreamWorker() {
  const specs = new Map(workloads.map(spec => [spec.name, spec]));
  for (const protocol of ['claude', 'codex']) {
    specs.set(`${protocol}-json`, { protocol, json: true });
    specs.set(`${protocol}-utf8-split`, { protocol, splitUtf8: true });
    for (const status of [401, 429]) specs.set(`${protocol}-${status}`, { protocol, status });
  }
  const bodies = new Map([...specs].map(([name, spec]) => [name, spec.status
    ? JSON.stringify({ error: { message: 'fixture rejection', type: 'fixture_error' } }) : responseBody(spec)]));
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { benchCase, benchId } = body.metadata;
      const protocol = req.url === '/v1/responses' ? 'codex' : 'claude';
      assert.equal(req.url, protocol === 'codex' ? '/v1/responses' : '/v1/messages');
      assert.equal(body.model, protocol === 'codex' ? 'gpt-fixture' : 'wire-model');
      assert.equal(req.headers.authorization, 'Bearer bench-upstream-key');
      assert.notEqual(req.headers.authorization, 'Bearer bench-downstream-key');
      if (benchCase.startsWith('cancel-')) {
        res.once('close', () => process.send({ event: 'upstream-close', id: benchId }));
        if (benchCase === 'cancel-stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n');
        }
        process.send({ event: 'upstream-open', id: benchId }); return;
      }
      const spec = specs.get(benchCase); assert.ok(spec);
      res.writeHead(spec.status || 200, { 'content-type': spec.json || spec.status ? 'application/json' : 'text/event-stream' });
      const payload = bodies.get(benchCase);
      if (spec.splitUtf8) {
        const bytes = Buffer.from(payload.join('')); let offset = 0, index;
        while ((index = bytes.indexOf(Buffer.from('中'), offset)) >= 0) {
          res.write(bytes.subarray(offset, index + 1)); offset = index + 1;
          await sleep(5); // 强制在三字节中文字符内部形成上游数据块边界。
        }
        return res.end(bytes.subarray(offset));
      }
      if (!spec.intervalMs) return res.end(Array.isArray(payload) ? payload.join('') : payload);
      for (const part of payload) {
        if (res.destroyed) return;
        res.write(part); await sleep(spec.intervalMs);
      }
      res.end();
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  process.on('message', async message => {
    if (message.op === 'stop') { await close(server); process.exit(0); }
  });
  process.send({ ready: true, url: await listen(server) });
}

async function proxyWorker() {
  const express = require('express');
  const { createProviderRouterRuntime } = require('../src/providers/router-runtime');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-cpr-compare-'));
  const upstream = process.env.CPR_BENCH_UPSTREAM;
  const entries = {
    main: { name: 'fixture', settingsConfig: { env: { ANTHROPIC_BASE_URL: upstream,
      ANTHROPIC_AUTH_TOKEN: 'bench-upstream-key', ANTHROPIC_DEFAULT_SONNET_MODEL: 'wire-model' } } },
    codex: { name: 'fixture', settingsConfig: { auth: { OPENAI_API_KEY: 'bench-upstream-key' },
      config: `model_provider = "fixture"\n[model_providers.fixture]\nbase_url = "${upstream}/v1"\nwire_api = "responses"\n` } },
  };
  const runtime = createProviderRouterRuntime({ providers: {
    getProvider: (_, id) => entries[id] || null, getProviderSummary: () => null,
    resolveSpawnEnv: () => ({ env: {} }), buildChildEnv: () => ({ env: {} }), resolveSessionWireModel: value => value,
  }, env: { MULTICC_CPR_BACKEND: process.env.CPR_BENCH_BACKEND }, mode: 'cpr', dataRoot: root, codexHomesDir: path.join(root, 'codex') });
  const app = express(); app.use(express.json({ limit: '50mb', type: req => req.url.startsWith('/codex-proxy/') }));
  let counts, timer, histogram, startCpu, startLoop, startTime, lastBeat, maxBeat, peakRss, startRss, captureDeltas;
  const resetCounts = () => { counts = { usage: 0, end: 0, statuses: {}, tokens: {}, deltaEvents: 0, deltaBytes: 0 }; };
  resetCounts();
  const mounted = runtime.mountProtocolProxies(app, { protocols: ['claude', 'codex'], codexProxyTrace: false,
    claudeProxy: { captureEnabled: false },
    onUsageObserved: event => {
      counts.usage++; counts.statuses[event.status] = (counts.statuses[event.status] || 0) + 1;
      for (const [key, value] of Object.entries(event.tokens || {})) if (typeof value === 'number') counts.tokens[key] = (counts.tokens[key] || 0) + value;
    },
    onActivity: event => { if (event.phase === 'end') counts.end++; },
    onDelta: event => { counts.deltaEvents++; counts.deltaBytes += Buffer.byteLength(event.text || '');
      if (captureDeltas) counts.deltaText += event.text || ''; },
  });
  app.use((error, req, res, next) => { if (res.headersSent) res.destroy(); else res.status(500).json({ error: error.message }); });
  const server = http.createServer(app);
  process.on('message', async message => {
    if (message.op === 'begin') {
      resetCounts(); captureDeltas = message.captureDeltas;
      if (captureDeltas) counts.deltaText = '';
      histogram = monitorEventLoopDelay({ resolution: 1 }); histogram.enable();
      startCpu = process.cpuUsage(); startLoop = performance.eventLoopUtilization();
      startTime = lastBeat = performance.now(); maxBeat = 0; startRss = peakRss = process.memoryUsage().rss;
      timer = setInterval(() => { const now = performance.now(); maxBeat = Math.max(maxBeat, now - lastBeat);
        lastBeat = now; peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
      process.send({ reply: message.id, value: true });
    } else if (message.op === 'finish') {
      clearInterval(timer); histogram.disable();
      const cpu = process.cpuUsage(startCpu), endRss = process.memoryUsage().rss;
      process.send({ reply: message.id, value: { ...counts, cpuMs: (cpu.user + cpu.system) / 1000,
        elapsedMs: performance.now() - startTime, loopUtilization: performance.eventLoopUtilization(startLoop).utilization,
        loopDelayP99Ms: histogram.percentile(99) / 1e6, loopDelayMaxMs: histogram.max / 1e6,
        maxHeartbeatGapMs: maxBeat, rssStartMiB: startRss / 1048576, rssEndMiB: endRss / 1048576,
        sampledPeakRssMiB: Math.max(peakRss, endRss) / 1048576 } });
    } else if (message.op === 'stop') {
      clearInterval(timer); await Promise.allSettled(Object.values(mounted).map(item => item.close?.()));
      await close(server); fs.rmSync(root, { recursive: true, force: true }); process.exit(0);
    }
  });
  process.send({ ready: true, backend: runtime.proxyBackend, url: await listen(server) });
}

async function worker(role, env = {}) {
  const child = fork(__filename, [], { env: { ...process.env, CPR_BENCH_ROLE: role, ...env }, silent: true });
  let stderr = '', rpcId = 0;
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  child.stdout.on('data', () => {});
  const pending = new Map(), events = new Map(), waiters = new Map();
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('worker start timeout: ' + role)), 20000);
    child.on('message', message => {
      if (message.ready) { clearTimeout(timeout); resolve(message); }
      if (message.reply) pending.get(message.reply)?.(message.value);
      if (message.event) {
        const key = `${message.event}:${message.id}`, callback = waiters.get(key);
        if (callback) { waiters.delete(key); callback(message); } else events.set(key, message);
      }
    });
    child.once('exit', code => { clearTimeout(timeout); if (code) reject(Error(`worker exited ${code}: ${stderr}`)); });
  });
  try {
    const info = await ready;
    return { ...info, child,
      request(op, options = {}) { return new Promise((resolve, reject) => {
        const id = ++rpcId, timer = setTimeout(() => { pending.delete(id); reject(Error(`IPC timeout ${role}:${op}`)); }, 10000);
        pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value); }); child.send({ id, op, ...options });
      }); },
      event(type, id) { return new Promise((resolve, reject) => {
        const key = `${type}:${id}`;
        if (events.has(key)) { const message = events.get(key); events.delete(key); resolve(message); return; }
        const timer = setTimeout(() => { waiters.delete(key); reject(Error(`event timeout ${key}`)); }, 5000);
        waiters.set(key, value => { clearTimeout(timer); resolve(value); });
      }); },
      stop() { return new Promise(resolve => {
        if (child.exitCode !== null) return resolve();
        const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); }); child.send({ op: 'stop' });
      }); },
    };
  } catch (error) { child.kill('SIGKILL'); throw error; }
}

function inputBody(spec, id) {
  const text = 'x'.repeat(spec.inputBytes || 128);
  return JSON.stringify({ model: spec.protocol === 'claude' ? 'sonnet' : 'gpt-fixture',
    ...(spec.protocol === 'claude' ? { messages: [{ role: 'user', content: text }] } : { input: [{ role: 'user', content: text }] }),
    stream: !spec.json, metadata: { benchCase: spec.name, benchId: id } });
}
const route = protocol => protocol === 'claude' ? '/claude-proxy/main/bench/v1/messages' : '/codex-proxy/codex/bench/main/responses';
function request(base, spec, agent, body) {
  return new Promise((resolve, reject) => {
    const start = performance.now(); let firstByteMs, bytes = 0, preview = '';
    const hash = createHash('sha256');
    const req = http.request(base + route(spec.protocol), { agent, method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer bench-downstream-key',
    } }, res => {
      res.on('data', chunk => { firstByteMs ??= performance.now() - start; bytes += chunk.length; hash.update(chunk);
        if (spec.captureBody && preview.length < 4096) preview += chunk.toString('utf8').slice(0, 4096 - preview.length); });
      res.once('error', reject);
      res.on('end', () => resolve({ ms: performance.now() - start, firstByteMs, status: res.statusCode, hash: hash.digest('hex'), bytes, preview }));
    });
    req.setTimeout(15000, () => req.destroy(Error('request timeout'))); req.once('error', reject); req.end(body);
  });
}
async function batch(base, spec, concurrency, requests, agent) {
  const body = inputBody(spec, 'timed'), payload = responseBody(spec);
  const expected = digest(Array.isArray(payload) ? payload.join('') : payload);
  let cursor = 0; const samples = [], start = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (cursor++ < requests) {
      const sample = await request(base, spec, agent, body);
      assert.equal(sample.status, 200); assert.equal(sample.hash, expected, 'raw response mismatch'); samples.push(sample);
    }
  }));
  const ms = performance.now() - start;
  return { requests, ms, rps: requests * 1000 / ms, p50Ms: quantile(samples.map(s => s.ms), 0.5),
    p95Ms: quantile(samples.map(s => s.ms), 0.95), firstByteP50Ms: quantile(samples.map(s => s.firstByteMs), 0.5),
    responseBytes: samples[0].bytes, requestBytes: Buffer.byteLength(body) };
}

async function verify(peers, upstream) {
  const evidence = [], snapshots = [];
  for (const backend of ['node', 'rust']) {
    const peer = peers[backend], agent = new http.Agent({ keepAlive: true });
    try {
      await peer.request('begin');
      for (const protocol of ['claude', 'codex']) {
        for (const kind of ['small', 'json', '401', '429']) {
          const spec = { ...(workloads.find(s => s.name === `${protocol}-${kind}`)
            || { name: `${protocol}-${kind}`, protocol, json: kind === 'json' }), captureBody: true };
          const result = await request(peer.url, spec, agent, inputBody(spec, kind));
          const payload = ['401', '429'].includes(kind) ? JSON.stringify({ error: { message: 'fixture rejection', type: 'fixture_error' } }) : responseBody(spec);
          const rawBytesVerified = result.hash === digest(Array.isArray(payload) ? payload.join('') : payload);
          const codexNodeError = protocol === 'codex' && backend === 'node' && ['401', '429'].includes(kind);
          assert.equal(result.status, codexNodeError ? 200 : Number(kind) || 200, `${backend} ${spec.name} HTTP status`);
          if (codexNodeError) assert.match(result.preview, /response.failed/);
          else assert.ok(rawBytesVerified, `${backend} ${spec.name} raw response mismatch`);
          evidence.push({ backend, case: spec.name, status: result.status, rawBytesVerified,
            ...(['401','429'].includes(kind) ? { errorPreview: result.preview } : {}) });
        }
      }
      snapshots.push(await peer.request('finish'));
    } finally { agent.destroy(); }
  }
  const callbackDifferences = [];
  for (const key of ['usage', 'end', 'statuses', 'tokens', 'deltaEvents', 'deltaBytes']) {
    if (JSON.stringify(snapshots[0][key]) !== JSON.stringify(snapshots[1][key])) callbackDifferences.push({key,node:snapshots[0][key],rust:snapshots[1][key]});
  }
  const cancellation = {};
  for (const backend of ['node', 'rust']) {
    const peer = peers[backend]; cancellation[backend] = {};
    await peer.request('begin');
    for (const stage of ['headers', 'stream']) {
      const latencies = [];
      for (let i = 0; i < 12; i++) {
        const id = `${backend}-${stage}-${i}`, spec = { name: 'cancel-' + stage, protocol: 'claude' };
        const body = inputBody(spec, id);
        let response;
        const req = http.request(peer.url + route('claude'), { method: 'POST', headers: { 'content-type': 'application/json' } });
        const first = new Promise(resolve => req.once('response', res => { response = res; res.once('error', () => {}); res.once('data', resolve); res.resume(); }));
        req.on('error', () => {}); req.end(body);
        await upstream.event('upstream-open', id); if (stage === 'stream') await first;
        const closed = upstream.event('upstream-close', id), start = performance.now();
        req.destroy(); response?.destroy(); await closed; latencies.push(performance.now() - start);
      }
      cancellation[backend][stage] = { samples: latencies.map(round), p50Ms: median(latencies), p95Ms: round(quantile(latencies, 0.95)) };
    }
    await sleep(20); const stats = await peer.request('finish');
    assert.equal(stats.end, 24); assert.equal(stats.usage, 24);
    cancellation[backend].logicalEndEvents = stats.end;
  }
  const unicodeSplit = [];
  for (const protocol of ['claude', 'codex']) for (const backend of ['node', 'rust']) {
    const peer = peers[backend], agent = new http.Agent({ keepAlive: true });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const spec = { protocol, name: `${protocol}-utf8-split` };
        await peer.request('begin', { captureDeltas: true });
        const result = await request(peer.url, spec, agent, inputBody(spec, `unicode-${attempt}`));
        const snapshot = await peer.request('finish');
        assert.equal(result.status, 200); assert.equal(result.hash, digest(responseBody(spec).join('')));
        const expectedText = ('中文🌏' + 'x'.repeat(64)).repeat(4);
        const textMatchesExpected = snapshot.deltaText === expectedText;
        if (backend === 'rust') assert.equal(textMatchesExpected, true, 'Rust UTF-8 sidecar mismatch');
        unicodeSplit.push({ protocol, backend, attempt, rawBytesVerified: true, textMatchesExpected,
          deltaEvents: snapshot.deltaEvents, deltaBytes: snapshot.deltaBytes,
          replacementCharacters: [...snapshot.deltaText].filter(char => char === '\ufffd').length,
          deltaPreview: snapshot.deltaText.slice(0, 90) });
      }
    } finally { agent.destroy(); }
  }
  return { cases: evidence, callbackParity: callbackDifferences.length === 0, callbackDifferences,
    callbacks: snapshots.map(snapshot => Object.fromEntries(['usage','end','statuses','tokens','deltaEvents','deltaBytes'].map(key => [key,snapshot[key]]))),
    cancellation, unicodeSplit };
}

async function main() {
  const rounds = Number(process.env.CPR_BENCH_ROUNDS || 5);
  assert.ok(Number.isInteger(rounds) && rounds >= 3);
  const resources = [], agents = {};
  try {
    const upstream = await worker('upstream'); resources.push(upstream);
    const peers = {};
    for (const backend of ['node', 'rust']) {
      peers[backend] = await worker('proxy', { CPR_BENCH_BACKEND: backend, CPR_BENCH_UPSTREAM: upstream.url }); resources.push(peers[backend]);
      assert.equal(peers[backend].backend, backend); agents[backend] = new http.Agent({ keepAlive: true, maxSockets: 16 });
    }
    require('../src/native/runtime').getNative('cpr', 'rust');
    const addon = process.env.MULTICC_RUST_ADDON || path.join(process.env.MULTICC_RUST_PREBUILT_DIR
      || path.resolve(__dirname, '../native/prebuilt'), `${process.platform}-${process.arch}`, 'multicc_core.node');
    const report = { environment: { at: new Date().toISOString(), cpu: os.cpus()[0].model, platform: process.platform,
      arch: process.arch, os: os.release(), node: process.version, cpr: require('cli-provider-router/package.json').version,
      addonSha256: digest(fs.readFileSync(addon)) },
      method: { rounds, warmupRequestsPerBackendPerScenario: '200 for small requests, 12 otherwise', order: 'alternating Node/Rust each round; isolated proxy processes',
        scope: 'local HTTP/1.1 with keepalive, synthetic providers, real host proxy path and callbacks; no TLS or provider inference',
        firstByte: 'first response body byte, not model first-token latency', metrics: 'proxy process CPU incl. native threads; event loop histogram; sampled process RSS, not system-wide peak' },
      correctness: await verify(peers, upstream), workloads: [] };
    console.error(`Correctness: 16 basic HTTP cases, callback parity=${report.correctness.callbackParity}, 48 cancellations, 12 UTF-8 cases; Codex Node wraps HTTP errors as SSE`);
    for (const spec of process.env.CPR_BENCH_VERIFY_ONLY === '1' ? [] : workloads) for (const concurrency of spec.concurrency) {
      for (const backend of ['node','rust']) await batch(peers[backend].url, spec, concurrency,
        spec.requests === 2000 ? 200 : 12, agents[backend]);
      const samples = { node: [], rust: [] };
      for (let i = 0; i < rounds; i++) for (const backend of i % 2 ? ['rust','node'] : ['node','rust']) {
        await peers[backend].request('begin');
        const client = await batch(peers[backend].url, spec, concurrency, spec.requests, agents[backend]);
        const proxy = await peers[backend].request('finish');
        assert.equal(proxy.end, spec.requests); assert.equal(proxy.usage, spec.requests);
        samples[backend].push({ ...client, ...proxy });
      }
      const summarize = values => Object.fromEntries(['rps','p50Ms','p95Ms','firstByteP50Ms','cpuMs','loopDelayP99Ms','loopDelayMaxMs',
        'maxHeartbeatGapMs','rssEndMiB','sampledPeakRssMiB'].map(key => [key, median(values.map(v => v[key]))]));
      const callbackDifferences = [];
      for (let i = 0; i < rounds; i++) for (const key of ['tokens','statuses','deltaEvents','deltaBytes']) {
        if (JSON.stringify(samples.node[i][key]) !== JSON.stringify(samples.rust[i][key])) callbackDifferences.push({ round: i, key,
          node: samples.node[i][key], rust: samples.rust[i][key] });
      }
      const node = summarize(samples.node), rust = summarize(samples.rust);
      const item = { name: spec.name, concurrency, requestsPerRound: spec.requests, requestBytes: samples.node[0].requestBytes,
        responseBytes: samples.node[0].responseBytes, node, rust, callbackDifferences,
        throughputRatioRustOverNode: round(rust.rps / node.rps), samples };
      report.workloads.push(item);
      console.error(`${spec.name} c=${concurrency}: Node ${node.p50Ms}ms / ${node.rps} req/s; Rust ${rust.p50Ms}ms / ${rust.rps} req/s`);
    }
    report.environment.finishedAt = new Date().toISOString();
    const text = JSON.stringify(report,null,2)+'\n';
    if (process.env.CPR_BENCH_OUTPUT) fs.writeFileSync(process.env.CPR_BENCH_OUTPUT,text);
    else process.stdout.write(text);
  } finally {
    for (const agent of Object.values(agents)) agent.destroy();
    for (const peer of resources.reverse()) await peer.stop();
  }
}

if (process.send) process.once('disconnect', () => process.exit(0));
(process.env.CPR_BENCH_ROLE === 'upstream' ? upstreamWorker() : process.env.CPR_BENCH_ROLE === 'proxy' ? proxyWorker() : main())
  .catch(error => { console.error(error); process.exitCode = 1; if (process.send) process.exit(1); });
