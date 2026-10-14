'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { matchesPattern, isKnownPattern, EVENT_TYPES } = require('../src/events/catalog');
const { deriveTaskEvents } = require('../src/events/task-transitions');
const { createEventHub } = require('../src/events/hub');
const { createEventRuleEngine } = require('../src/events/engine');
const { validateEventRule } = require('../src/events/rules');
const { isPrivateAddress, sign } = require('../src/events/actions');
const { createSessionTriggers } = require('../src/triggers');

const base = { taskId: 't1', goal: 'ship it', phase: 'impl', startedAt: 1, classifyState: 'P', goalState: null };

function harness(extra = {}) {
  const bus = new EventEmitter();
  let n = 0;
  const hub = createEventHub({ bus, randomUUID: () => `e${++n}`, now: () => 1000, dirIdOf: () => 'dir1' });
  hub.start();
  const log = [];
  hub.subscribe((event) => log.push(event));
  return { bus, hub, log };
}

test('catalog: aliases and wildcards expand only at match time', () => {
  assert.ok(matchesPattern('task.attention', 'task.failed'));
  assert.ok(matchesPattern('task.attention', 'task.needs_interaction'));
  assert.ok(!matchesPattern('task.attention', 'task.achieved'));
  assert.ok(matchesPattern('task.done', 'task.achieved'));
  assert.ok(matchesPattern('task.*', 'task.running'));
  assert.ok(!matchesPattern('task.*', 'turn.completed'));
  assert.ok(!isKnownPattern('task.bogus'));
  assert.ok(!EVENT_TYPES.includes('task.attention'));
});

test('transitions: D without goalState, then refine to achieved', () => {
  const d = { ...base, classifyState: 'D' };
  const first = deriveTaskEvents(base, d).map((e) => e.type);
  assert.deepEqual(first, ['task.finished']);
  const refined = deriveTaskEvents(d, { ...d, goalState: 'achieved' });
  assert.deepEqual(refined.map((e) => e.type), ['task.goal_resolved', 'task.achieved']);
  assert.equal(refined[0].data.source, 'refine');
  assert.equal(refined[0].data.from, null);
});

test('transitions: D arriving with goalState carries classify source', () => {
  const events = deriveTaskEvents(base, { ...base, classifyState: 'D', goalState: 'interact' });
  assert.deepEqual(events.map((e) => e.type), ['task.finished', 'task.goal_resolved', 'task.needs_interaction']);
  assert.equal(events[1].data.source, 'classify');
});

test('transitions: manual interact -> achieved is detected as manual', () => {
  const prev = { ...base, classifyState: 'D', goalState: 'interact' };
  const next = { ...prev, goalState: 'achieved', goalStateManualAt: 99 };
  const events = deriveTaskEvents(prev, next);
  assert.deepEqual(events.map((e) => e.type), ['task.goal_resolved', 'task.achieved']);
  assert.equal(events[0].data.source, 'manual');
  assert.equal(events[0].data.from, 'interact');
});

test('transitions: goal cleared on new turn emits only task.running', () => {
  const prev = { ...base, classifyState: 'D', goalState: 'achieved' };
  const events = deriveTaskEvents(prev, { ...base, classifyState: 'P', goalState: null });
  assert.deepEqual(events.map((e) => e.type), ['task.running']);
});

test('transitions: E marks cancelled vs error; new task id after D is restarted', () => {
  const cancelled = deriveTaskEvents(base, { ...base, classifyState: 'E', cancelledAt: 5, cancelReason: 'user' });
  assert.equal(cancelled[0].type, 'task.failed');
  assert.equal(cancelled[0].data.cancelled, true);
  const failed = deriveTaskEvents(base, { ...base, classifyState: 'E', apiError: { category: 'rate_limit' } });
  assert.equal(failed[0].data.cancelled, false);
  assert.equal(failed[0].data.errorCategory, 'rate_limit');
  const restarted = deriveTaskEvents({ ...base, classifyState: 'D' }, { ...base, taskId: 't2', classifyState: 'P' });
  assert.deepEqual(restarted.map((e) => e.type), ['task.restarted', 'task.running']);
});

test('transitions: unchanged state and unknown letters emit nothing', () => {
  assert.deepEqual(deriveTaskEvents(base, { ...base, goal: 'renamed' }), []);
  assert.deepEqual(deriveTaskEvents(base, { ...base, classifyState: 'C' }), []);
});

test('hub: bus task:state-changed -> envelope; goal events are idempotent per segment', () => {
  const { bus, log } = harness();
  const d = { ...base, classifyState: 'D' };
  bus.emit('task:state-changed', 's1', base, d);
  bus.emit('task:state-changed', 's1', d, { ...d, goalState: 'achieved' });
  // re-applying the same value (e.g. manual mark after classify) must not refire
  bus.emit('task:state-changed', 's1', { ...d, goalState: 'interact' }, { ...d, goalState: 'achieved', goalStateManualAt: 5 });
  const types = log.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'task.achieved').length, 1);
  assert.equal(types.filter((t) => t === 'task.finished').length, 1);
  assert.equal(log[0].sessionId, 's1');
  assert.equal(log[0].dirId, 'dir1');
  assert.equal(log[0].eventId, 'e1');
  assert.ok(log.every((e, i) => e.seq === i + 1));
});

test('hub: leaving D re-arms goal events; subscriber throw is isolated', () => {
  const { bus, hub, log } = harness();
  hub.subscribe(() => { throw new Error('boom'); });
  const d = { ...base, classifyState: 'D', goalState: 'achieved' };
  bus.emit('task:state-changed', 's1', base, d);
  bus.emit('task:state-changed', 's1', d, base);
  bus.emit('task:state-changed', 's1', base, d);
  assert.equal(log.filter((e) => e.type === 'task.achieved').length, 2);
});

test('hub: turn.completed only for durable results', () => {
  const { bus, log } = harness();
  bus.emit('chat:turn-complete', 's1', {}, { resultDurable: false });
  bus.emit('chat:turn-complete', 's1', {}, { resultDurable: true, turnId: 'x', lineage: { kind: 'trigger' } });
  assert.equal(log.length, 1);
  assert.equal(log[0].type, 'turn.completed');
  assert.equal(log[0].data.lineageKind, 'trigger');
});

test('rules: validation rejects bad patterns, actions, urls and enforces inject cooldown floor', () => {
  const opts = { idFactory: () => 'r1', nowIso: () => 'now' };
  assert.match(validateEventRule({ on: ['nope.x'], action: { kind: 'notify' } }, opts).error, /unknown event pattern/);
  assert.match(validateEventRule({ on: ['task.failed'], action: { kind: 'rm' } }, opts).error, /unknown action/);
  assert.match(validateEventRule({ on: ['task.failed'], action: { kind: 'webhook', url: 'file:///x' } }, opts).error, /http/);
  assert.match(validateEventRule({ on: ['task.failed'], action: { kind: 'webhook', url: 'https://u:p@x.io' } }, opts).error, /credentials/);
  const ok = validateEventRule({ on: 'task.attention', cooldownMs: 1, action: { kind: 'inject-prompt', prompt: 'hi' } }, opts);
  assert.equal(ok.rule.cooldownMs, 10000);
  assert.deepEqual(ok.rule.on, ['task.attention']);
});

function engineHarness(extra = {}) {
  const { bus, hub, log } = harness();
  const persistedSessions = new Map([['s1', { id: 's1', dirId: 'dir1', triggers: [] }]]);
  const calls = { notify: [], inject: [], http: [] };
  let stored = null;
  const engine = createEventRuleEngine({
    hub, persistedSessions, now: () => 1000000, idFactory: (() => { let i = 0; return () => `r${++i}`; })(),
    store: { read: () => stored, write: (v) => { stored = JSON.parse(JSON.stringify(v)); } },
    notify: (...a) => { calls.notify.push(a); return {}; },
    injectPrompt: (...a) => { calls.inject.push(a); return true; },
    resolveSecret: (n) => (n === 'hook' ? 's3cret' : null),
    lookup: async () => [{ address: '93.184.216.34' }],
    httpPost: async (url, headers, body) => { calls.http.push({ url: String(url), headers, body }); return 200; },
    sleep: async () => {},
    ...extra,
  });
  engine.start();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { bus, hub, log, engine, persistedSessions, calls, settle, get stored() { return stored; } };
}

const toD = (extra = {}) => ({ ...base, classifyState: 'D', ...extra });

test('engine: global notify rule fires on task.failed with mapped push type', async () => {
  const h = engineHarness();
  assert.ok(h.engine.addGlobal({ on: ['task.failed'], action: { kind: 'notify' } }).rule);
  h.bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E', apiError: { category: 'x' } });
  await h.settle();
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.calls.notify[0][1], 'error');
  assert.ok(h.log.some((e) => e.type === 'trigger.fired'));
});

test('engine: filter goalState and alias attention; no match no action', async () => {
  const h = engineHarness();
  h.engine.addGlobal({ on: ['task.achieved'], filter: { goalState: 'achieved' }, action: { kind: 'notify' } });
  h.engine.addGlobal({ on: ['task.attention'], action: { kind: 'notify', message: 'look' } });
  h.bus.emit('task:state-changed', 's1', base, toD());
  await h.settle();
  assert.equal(h.calls.notify.length, 0); // finished with no goalState matches neither
  h.bus.emit('task:state-changed', 's1', toD(), toD({ goalState: 'interact' }));
  await h.settle();
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.calls.notify[0][2], 'look');
});

test('engine: cooldown suppresses repeats; disabled rules never run', async () => {
  const h = engineHarness();
  h.engine.addGlobal({ on: ['task.running'], cooldownMs: 60000, action: { kind: 'notify' } });
  const off = h.engine.addGlobal({ on: ['task.running'], enabled: false, action: { kind: 'notify' } });
  assert.equal(off.rule.enabled, false);
  h.bus.emit('task:state-changed', 's1', toD(), base);
  h.bus.emit('task:state-changed', 's1', base, toD());
  h.bus.emit('task:state-changed', 's1', toD(), base);
  await h.settle();
  assert.equal(h.calls.notify.length, 1);
});

test('engine: inject loop latch - the turn we caused does not re-trigger inject', async () => {
  const h = engineHarness({ now: (() => { let t = 0; return () => (t += 100000); })() });
  h.engine.addGlobal({ on: ['task.finished'], action: { kind: 'inject-prompt', prompt: 'review' } });
  h.bus.emit('task:state-changed', 's1', base, toD());
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  assert.equal(h.calls.inject[0][0], 's1');
  assert.ok(h.calls.inject[0][1].trimEnd().endsWith('你的指令：review'));
  // the injected turn runs and ends: terminal event must not inject again
  h.bus.emit('task:state-changed', 's1', toD(), base);
  h.bus.emit('task:state-changed', 's1', base, toD());
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  // a later genuine turn (latch consumed) can inject again
  h.bus.emit('task:state-changed', 's1', toD(), base);
  h.bus.emit('task:state-changed', 's1', base, toD());
  await h.settle();
  assert.equal(h.calls.inject.length, 2);
});

test('engine: session-level event trigger is scoped to its own session', async () => {
  const h = engineHarness();
  h.persistedSessions.set('s2', { id: 's2', dirId: 'dir1', triggers: [] });
  const { rule } = validateEventRule({ on: ['task.failed'], action: { kind: 'notify' } }, { idFactory: () => 'mine', nowIso: () => 'n', scope: 'session' });
  h.persistedSessions.get('s1').triggers.push(rule);
  h.bus.emit('task:state-changed', 's2', base, { ...base, classifyState: 'E' });
  await h.settle();
  assert.equal(h.calls.notify.length, 0);
  h.bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E' });
  await h.settle();
  assert.equal(h.calls.notify.length, 1);
  assert.equal(h.persistedSessions.get('s1').triggers[0].lastFiredAt, 1000000);
});

test('engine: webhook is signed, public-only, retried on 5xx, never retried on 4xx', async () => {
  const h = engineHarness();
  h.engine.addGlobal({ on: ['task.failed'], action: { kind: 'webhook', url: 'https://hooks.example.com/x', secretName: 'hook' } });
  h.bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E' });
  await h.settle();
  assert.equal(h.calls.http.length, 1);
  const { headers, body } = h.calls.http[0];
  assert.equal(headers['X-Multicc-Signature'], sign('s3cret', body, headers['X-Multicc-Timestamp']));
  const parsed = JSON.parse(body);
  assert.equal(parsed.type, 'task.failed');
  assert.ok(!('cwd' in parsed.data));
});

test('engine: webhook retries then gives up; private targets blocked; 4xx not retried', async () => {
  let statuses = [500, 502, 503];
  const h = engineHarness({ httpPost: async () => statuses.shift() });
  h.engine.addGlobal({ on: ['task.running'], action: { kind: 'webhook', url: 'https://hooks.example.com/x' } });
  h.bus.emit('task:state-changed', 's1', toD(), base);
  await h.settle(); await h.settle();
  assert.equal(statuses.length, 0);
  assert.equal(h.engine.recentResults().at(-1).ok, false);

  const priv = engineHarness({ lookup: async () => [{ address: '127.0.0.1' }] });
  priv.engine.addGlobal({ on: ['task.running'], action: { kind: 'webhook', url: 'https://evil.example.com/x' } });
  priv.engine.addGlobal({ on: ['task.running'], action: { kind: 'webhook', url: 'http://169.254.169.254/' } });
  priv.bus.emit('task:state-changed', 's1', toD(), base);
  await priv.settle();
  assert.equal(priv.calls.http.length, 0);
  assert.ok(priv.engine.recentResults().every((r) => r.error === 'private address blocked'));

  let four = 0;
  const f = engineHarness({ httpPost: async () => { four += 1; return 404; } });
  f.engine.addGlobal({ on: ['task.running'], action: { kind: 'webhook', url: 'https://hooks.example.com/x' } });
  f.bus.emit('task:state-changed', 's1', toD(), base);
  await f.settle();
  assert.equal(four, 1);
});

test('engine: a rule on * cannot loop through trigger.fired; depth capped', async () => {
  const h = engineHarness();
  h.engine.addGlobal({ on: ['*'], action: { kind: 'notify' } });
  h.bus.emit('task:state-changed', 's1', toD(), base);
  await h.settle();
  assert.equal(h.calls.notify.length, 1); // task.running only; trigger.fired not matched by *
  assert.ok(h.log.filter((e) => e.type === 'trigger.fired').every((e) => e.depth === 1));
});

test('engine: global rules persist and reload; corrupt/invalid CRUD is rejected', () => {
  const h = engineHarness();
  const { rule } = h.engine.addGlobal({ name: 'a', on: ['task.achieved'], action: { kind: 'notify' } });
  assert.equal(h.stored.rules.length, 1);
  assert.equal(h.engine.updateGlobal(rule.id, { enabled: false }).rule.enabled, false);
  assert.equal(h.engine.updateGlobal('missing', {}).status, 404);
  assert.match(h.engine.updateGlobal(rule.id, { on: ['bad'] }).error, /unknown/);
  assert.equal(h.engine.removeGlobal(rule.id), true);
  assert.equal(h.engine.removeGlobal(rule.id), false);
  assert.equal(h.stored.rules.length, 0);
});

test('private address classifier', () => {
  for (const a of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.20.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1', 'garbage']) {
    assert.ok(isPrivateAddress(a), a);
  }
  for (const a of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.ok(!isPrivateAddress(a), a);
});

test('session triggers accept type:event and reject bad event rules', () => {
  const runtime = createSessionTriggers({
    crypto: { randomUUID: () => 'gen' },
    cron: { validate: () => true, schedule: () => ({}) },
    chokidar: { watch: () => ({}) },
    fs: { existsSync: () => true },
    path: require('node:path'),
    bus: new EventEmitter(),
    persistedSessions: new Map(),
    chatSessions: new Map(),
    sessionPersistence: { mutate: (s, m) => m() },
    saveBestEffort() {}, cwdForSession() {}, appendEvent() {}, chatBroadcast() {},
  });
  const ok = runtime.validateTrigger({ type: 'event', on: ['task.attention'], action: { kind: 'notify' } });
  assert.equal(ok.trigger.type, 'event');
  assert.equal(ok.trigger.id, 'gen');
  assert.ok(runtime.validateTrigger({ type: 'event', on: ['zzz.x'], action: { kind: 'notify' } }).error);
  assert.equal(runtime.triggerLabel(ok.trigger), '事件 task.attention');
});

// ── event envelope ──────────────────────────────────────────────────────────
const envelope = require('../src/events/envelope');

test('envelope: conclusion = last non-empty assistant reply, clipped and redacted', () => {
  const history = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'old answer' },
    { role: 'assistant', content: [{ type: 'text', text: 'done, key sk-abcdefghijklmnop1234 ok' }, { type: 'tool_use' }] },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: 'thanks' },
  ];
  assert.equal(envelope.conclusionFromHistory(history), 'done, key *** ok');
  assert.equal(envelope.conclusionFromHistory([]), '');
  assert.equal(envelope.conclusionFromHistory(null), '');
  const long = envelope.conclusionFromHistory([{ role: 'assistant', content: 'x'.repeat(5000) }]);
  assert.ok(long.length <= envelope.CONCLUSION_MAX + 1);
  assert.match(envelope.redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), /\*\*\*/);
});

test('envelope: injection text carries fixed fields and ends with the user instruction', () => {
  const text = envelope.renderInjection({
    type: 'task.achieved', sessionId: 's1',
    data: { goal: 'ship', goalState: 'achieved', summary: 'sum', conclusion: 'all green' },
  }, '部署到测试环境');
  assert.match(text, /事件 task\.achieved/);
  assert.match(text, /来源会话：s1/);
  assert.match(text, /达成目标/);
  assert.match(text, /上一轮结论[\s\S]*all green/);
  assert.ok(text.trimEnd().endsWith('你的指令：部署到测试环境'));
  const failed = envelope.renderInjection({ type: 'task.failed', sessionId: 's1', data: { errorCategory: 'rate_limit', cancelled: true } }, '');
  assert.match(failed, /错误类别：rate_limit（用户主动停止）/);
  assert.match(failed, /你的指令：请根据以上信息/);
});

test('hub: terminal events carry conclusion+summary once-read; running does not', () => {
  const bus = new EventEmitter();
  let reads = 0;
  const hub = createEventHub({ bus, conclusionOf: () => { reads += 1; return 'final words'; } });
  hub.start();
  const log = [];
  hub.subscribe((event) => log.push(event));
  bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'D', goalState: 'achieved', lastSummary: 'brief' });
  const types = log.map((e) => e.type);
  assert.deepEqual(types, ['task.finished', 'task.goal_resolved', 'task.achieved']);
  assert.ok(log.every((e) => e.data.conclusion === 'final words' && e.data.summary === 'brief'));
  assert.equal(reads, 1);
  bus.emit('task:state-changed', 's1', { ...base, classifyState: 'D' }, base);
  assert.equal(log.at(-1).type, 'task.running');
  assert.ok(!('conclusion' in log.at(-1).data));
});

test('hub: a throwing conclusion reader never blocks the event', () => {
  const bus = new EventEmitter();
  const hub = createEventHub({ bus, conclusionOf: () => { throw new Error('disk'); } });
  hub.start();
  const log = [];
  hub.subscribe((event) => log.push(event));
  bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E' });
  assert.equal(log[0].type, 'task.failed');
  assert.equal(log[0].data.conclusion, '');
});

test('webhook: conclusion only with includeConclusion; inject uses the envelope', async () => {
  const { webhookBody } = require('../src/events/actions');
  const event = { eventId: 'e', seq: 1, ts: 1, type: 'task.achieved', sessionId: 's1', dirId: 'd', data: { goal: 'g', goalState: 'achieved', conclusion: 'secret-ish reply', summary: 's' } };
  assert.ok(!('conclusion' in JSON.parse(webhookBody(event)).data));
  assert.equal(JSON.parse(webhookBody(event, true)).data.conclusion, 'secret-ish reply');
  assert.equal(validateEventRule({ on: ['task.failed'], action: { kind: 'webhook', url: 'https://a.io/x', includeConclusion: true } }, { idFactory: () => 'r', nowIso: () => 'n' }).rule.action.includeConclusion, true);
  assert.equal(validateEventRule({ on: ['task.failed'], action: { kind: 'webhook', url: 'https://a.io/x' } }, { idFactory: () => 'r', nowIso: () => 'n' }).rule.action.includeConclusion, false);

  const h = engineHarness();
  h.engine.addGlobal({ on: ['task.achieved'], action: { kind: 'inject-prompt', prompt: '继续部署' } });
  h.hub.emit('task.achieved', 's1', { goal: 'ship', goalState: 'achieved', conclusion: 'all green' });
  await h.settle();
  assert.equal(h.calls.inject.length, 1);
  assert.match(h.calls.inject[0][1], /all green/);
  assert.ok(h.calls.inject[0][1].trimEnd().endsWith('你的指令：继续部署'));
});

test('engine.listAll merges global + session event rules with last run; skips other trigger types', async () => {
  const h = engineHarness();
  h.persistedSessions.get('s1').label = 'My chat';
  const mine = validateEventRule({ on: ['task.failed'], action: { kind: 'notify' } }, { idFactory: () => 'mine', nowIso: () => 'n', scope: 'session' }).rule;
  h.persistedSessions.get('s1').triggers.push(mine, { id: 'x', type: 'post-turn', enabled: true });
  const global = h.engine.addGlobal({ on: ['task.achieved'], action: { kind: 'notify' } }).rule;
  h.bus.emit('task:state-changed', 's1', base, { ...base, classifyState: 'E' });
  await h.settle();
  const all = h.engine.listAll();
  assert.equal(all.length, 2);
  const session = all.find((item) => item.scope === 'session');
  assert.equal(session.sessionId, 's1');
  assert.equal(session.sessionLabel, 'My chat');
  assert.equal(session.lastRun.ok, true);
  const globalItem = all.find((item) => item.scope === 'global');
  assert.equal(globalItem.rule.id, global.id);
  assert.equal(globalItem.lastRun, null);
});
