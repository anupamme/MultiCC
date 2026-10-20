'use strict';

const assert = require('assert');
const { test } = require('node:test');
const { createUsageLimitWiring } = require('../src/chat/usage-limit-wiring');

function fakeProviders(target, summaries = {}) {
  return {
    appTypeForCli: (cli) => (cli === 'codex' ? 'codex' : cli === 'claude' ? 'claude' : null),
    getProviderLimitTarget: () => target,
    getProviderSummary: (appType, id) => summaries[id] || null,
  };
}

// createPoller stub: capture the resolveTarget/broadcast it's built with, and
// expose a way to drive them like the real poller would.
function stubPoller() {
  let cfg = null;
  const factory = (c) => { cfg = c; return { cfg }; };
  return { factory, resolve: (s) => cfg.resolveTarget(s), emit: (s, dto) => cfg.broadcast(s, dto) };
}

test('resolveTarget maps session→provider limit target; null for vendor CLI', () => {
  const sessions = new Map([
    ['glm-s', { provider: 'p-glm', cli: 'codex' }],
    ['qoder-s', { provider: 'p-q', cli: 'qoder' }],
    ['noprov', { cli: 'codex' }],
  ]);
  const sp = stubPoller();
  createUsageLimitWiring({
    persistedSessions: sessions,
    providers: fakeProviders({ providerId: 'p-glm', strategy: 'glm-monitor' }),
    chatBroadcast: () => {},
    createPoller: sp.factory,
  });
  assert.deepStrictEqual(sp.resolve('glm-s'), { providerId: 'p-glm', strategy: 'glm-monitor' });
  assert.strictEqual(sp.resolve('qoder-s'), null, 'vendor CLI (appType null) → no target');
  assert.strictEqual(sp.resolve('noprov'), null, 'no provider → no target');
  assert.strictEqual(sp.resolve('missing'), null, 'unknown session → no target');
});

test('broadcast maps window DTO → rate_limit_event, balance DTO → usage_balance_event', () => {
  const events = [];
  const sp = stubPoller();
  createUsageLimitWiring({
    persistedSessions: new Map(),
    providers: fakeProviders(null),
    chatBroadcast: (s, p) => events.push({ s, p }),
    createPoller: sp.factory,
  });

  sp.emit('sess', { kind: 'window', provider: 'glm', rateLimitType: 'five_hour', status: 'allowed', utilization: 0.44, resetsAt: 123 });
  assert.strictEqual(events[0].p.type, 'rate_limit_event');
  assert.deepStrictEqual(events[0].p.rate_limit_info, {
    rateLimitType: 'five_hour', status: 'allowed', utilization: 0.44, resetsAt: 123, provider: 'glm',
  });

  sp.emit('sess', { kind: 'balance', provider: 'deepseek', available: true, currency: 'CNY', total: 110 });
  assert.strictEqual(events[1].p.type, 'usage_balance_event');
  assert.strictEqual(events[1].p.balance_info.total, 110);

  // Unknown kind → no broadcast.
  sp.emit('sess', { kind: 'mystery' });
  assert.strictEqual(events.length, 2);
});

// The queue keys its Claude cache by ACCOUNT, and only this wiring knows both a
// session's provider and that provider's account — so it configures the resolver
// on the way in. The resolver must be a closure over the deps it was created
// with, not a module-level function reaching for globals: one written the latter
// way throws on every call, and the queue swallows that into the default key, so
// every account quietly shares one reading.
test('wiring installs a claude key resolver that resolves a session to its account', () => {
  const Queue = require('../src/quota/claude-usage-queue');
  const sessions = new Map([
    ['acct-2-s', { provider: 'claude-official-bbb', cli: 'claude' }],
    ['relay-s', { provider: 'zhipu', cli: 'claude' }],
    ['codex-s', { provider: 'p-codex', cli: 'codex' }],
    ['bare-s', { provider: 'claude-official', cli: 'claude' }],
  ]);
  Queue.resetClaudeUsageQueue();
  try {
    createUsageLimitWiring({
      persistedSessions: sessions,
      providers: fakeProviders(null, {
        'claude-official-bbb': { officialAccountId: 'bbb', baseUrl: '' },
        zhipu: { officialAccountId: null, baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
        'claude-official': { officialAccountId: null, baseUrl: '' },
      }),
      chatBroadcast: () => {},
      createPoller: stubPoller().factory,
    });
    assert.strictEqual(Queue.claudeProviderKey('acct-2-s'), 'claude:bbb');
    assert.strictEqual(Queue.claudeProviderKey('bare-s'), Queue.DEFAULT_KEY, 'the shared CLI login');
    assert.strictEqual(Queue.claudeProviderKey('relay-s'), '', 'routed elsewhere: no subscription reading');
    assert.strictEqual(Queue.claudeProviderKey('codex-s'), '', 'not a Claude session at all');
    assert.strictEqual(Queue.claudeProviderKey('ghost'), '');
    // Unresolvable sessions still get a bar; they just share the default reading.
    assert.strictEqual(Queue.claudeUsageKey('relay-s'), Queue.DEFAULT_KEY);
  } finally {
    Queue.resetClaudeUsageQueue();
  }
});

// A turn ending is NOT a reason to read a Claude account any more. The scrape
// costs an upstream call (or a 30-40s browser drive) and is taken only when the
// user asks for it — the bar's ⟳ / tap sends `force=1`. So the wiring hands
// onTurnComplete straight to the poller and never enqueues a Claude reading.
test('a turn ending does not scrape Claude, and the poller still runs', async () => {
  const Queue = require('../src/quota/claude-usage-queue');
  const sessions = new Map([['acct-s', { provider: 'p-official', cli: 'claude' }]]);
  Queue.resetClaudeUsageQueue();
  const scrapes = [];
  Queue.configureClaudeUsageQueue({
    fetchUsage: async ({ accountId } = {}) => { scrapes.push(accountId || ''); return { status: 'ok' }; },
  });
  const completed = [];
  const poller = {
    onTurnComplete: (s) => { completed.push(s); return Promise.resolve('poller-result'); },
    _refresh: 'refresh', _cache: 'cache',
  };
  try {
    const wiring = createUsageLimitWiring({
      persistedSessions: sessions,
      providers: fakeProviders(null, { 'p-official': { officialAccountId: 'aaa', baseUrl: '' } }),
      chatBroadcast: () => {},
      createPoller: () => poller,
    });
    assert.strictEqual(wiring, poller, 'no wrapper sits between the caller and the poller');
    assert.strictEqual(await wiring.onTurnComplete('acct-s'), 'poller-result');
    assert.deepStrictEqual(completed, ['acct-s'], 'the poller still gets its turn-complete');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(scrapes, [], 'nothing is scraped on the user’s behalf');
    // The account still resolves, so an explicit refresh knows whose numbers to
    // read — losing the resolver would quietly serve one shared reading instead.
    assert.strictEqual(Queue.claudeProviderKey('acct-s'), 'claude:aaa');
  } finally {
    Queue.resetClaudeUsageQueue();
  }
});

test('throws when required deps are missing', () => {
  assert.throws(() => createUsageLimitWiring({}), /requires/);
});
