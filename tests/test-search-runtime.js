'use strict';

// The message index as a running service (src/search/runtime.js).
//
// scripts/search-index.js covers the index itself; what is asserted here is the
// part that only exists once a server owns it:
//   1. the first sweep yields instead of blocking — a cold corpus is seconds of
//      CPU, and the server is listening while it happens;
//   2. one turn's worth of new text becomes searchable on the turn that produced
//      it, and re-syncing an unchanged session costs nothing;
//   3. every failure mode (no FTS5, a closed database, a throwing index) degrades
//      to "no results" — this port sits on the turn-end path and behind an HTTP
//      route, and neither may fail because a derived index did.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createSearchRuntime,
  getSharedSearchRuntime,
  resetSharedSearchRuntimes,
  DEFAULT_HITS,
} = require('../src/search/runtime');
const { createChatHistoryFileRepository } = require('../src/session/adapters/chat-history-file-repository');

const logger = { warn() {}, log() {}, info() {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-search-runtime-'));
}

// The first sweep is sliced across event-loop turns on purpose, so a test that
// wants to watch it happen has to own the deferral: collect the callbacks and run
// them by hand, one slice at a time.
function manualImmediate() {
  const queue = [];
  return {
    setImmediateImpl(fn) { queue.push(fn); },
    pending: () => queue.length,
    runOne() { queue.shift()(); },
    drain() {
      let guard = 0;
      while (queue.length) {
        if ((guard += 1) > 10_000) throw new Error('the staged sweep never finished');
        queue.shift()();
      }
    },
  };
}

function turn(id, text, role = 'user') {
  return { id, role, content: text };
}

function fixture({ sessions = {}, ...options } = {}) {
  const dir = tempDir();
  const history = createChatHistoryFileRepository({ dataDir: dir });
  for (const [sessionId, messages] of Object.entries(sessions)) history.write(sessionId, messages);
  const runtime = createSearchRuntime({ dataDir: dir, logger, intervalMs: 0, firstSweepBatch: 1, ...options });
  return {
    dir,
    history,
    runtime,
    cleanup: () => { runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('the staged first sweep yields between slices and prunes only once it is done', () => {
  const scheduler = manualImmediate();
  const { runtime, cleanup } = fixture({
    sessions: {
      a1: [turn('m1', '第一段会话正文，讲的是全文检索的排序。')],
      a2: [turn('m2', '第二段会话正文，讲的是缓存层重构。')],
      a3: [turn('m3', '第三段会话正文，讲的是任务关联候选。')],
    },
    setImmediateImpl: scheduler.setImmediateImpl,
  });
  try {
    runtime.start();
    assert.equal(runtime.status().started, true);
    assert.equal(runtime.status().warming, true, 'the corpus is not searchable while it is still being walked');
    assert.equal(scheduler.pending(), 1, 'start() defers the first slice rather than sweeping inline');
    assert.equal(runtime.stats().scopes.length, 0, 'nothing is indexed before the first slice runs');
    // A sweep landing mid-warm must not prune against a half-built ref list.
    assert.deepEqual(runtime.sweep(), { skipped: 'warming' });

    scheduler.drain();
    assert.equal(scheduler.pending(), 0);
    assert.equal(runtime.status().warming, false);
    assert.equal(runtime.status().sweeps, 1, 'the plain sweep at the end is the one that prunes');
    assert.equal(runtime.status().lastSweep.sessions, 3);
    assert.equal(runtime.stats().scopes[0].refs, 3, 'every live session ends up with a ref');

    const found = runtime.findMessages({ text: '全文检索' });
    assert.equal(found.length, 1);
    assert.equal(found[0].sessionId, 'a1');
    assert.ok(found[0].snippet.text.includes('全文检索'));
  } finally {
    cleanup();
  }
});

test('the 60s sweep is sliced: one slow session per slice, nothing parsed twice, pruning at the end', async () => {
  const scheduler = manualImmediate();
  const dir = tempDir();
  const repo = createChatHistoryFileRepository({ dataDir: dir });
  // The clock moves only when a history file is actually read, so the slice budget
  // bites on re-parsed sessions the way it does on a 100MB conversation.
  let clock = 1_000_000;
  let reads = 0;
  const history = { ...repo, read: id => { reads += 1; clock += 50; return repo.read(id); } };
  for (const id of ['s1', 's2', 's3', 'gone']) repo.write(id, [turn('m1', `会话 ${id} 的第一版正文，主题是缓存层。`)]);
  const runtime = createSearchRuntime({
    dataDir: dir, logger, intervalMs: 0, history, now: () => clock,
    setImmediateImpl: scheduler.setImmediateImpl,
  });
  try {
    runtime.sweep();
    assert.equal(runtime.stats().scopes[0].refs, 4);
    const baseline = runtime.status().sweeps;

    await sleep(5);
    for (const id of ['s1', 's2', 's3']) repo.write(id, [turn('m2', `会话 ${id} 改写后的正文，主题是排序。`)]);
    repo.deleteSession('gone');
    reads = 0;

    runtime.sweepSliced();
    assert.equal(scheduler.pending(), 1, 'the tick defers its first slice instead of sweeping inline');
    assert.equal(reads, 0, 'nothing is parsed inline');
    runtime.sweepSliced();
    assert.equal(scheduler.pending(), 1, 'a tick that lands mid-pass is refused');

    let slices = 0;
    while (scheduler.pending()) { scheduler.runOne(); slices += 1; assert.ok(slices < 50, 'the pass must finish'); }
    assert.equal(slices, 3, 'every re-parsed session overruns the budget, so each one gets its own slice');
    assert.equal(reads, 3, 'each changed session is parsed exactly once — the closing step does not re-sync');
    assert.equal(runtime.status().sweeps, baseline + 1);
    assert.equal(runtime.status().lastSweep.synced, 3);
    assert.equal(runtime.status().lastSweep.removedRefs, 1, 'the deleted session is pruned at the end');
    assert.equal(runtime.stats().scopes[0].refs, 3);
    assert.ok(runtime.findMessages({ text: '排序' }).length >= 1, 'the rewritten text is searchable');

    runtime.sweepSliced();
    assert.equal(scheduler.pending(), 1, 'the next tick is accepted once the previous pass is done');
    scheduler.drain();
    assert.equal(reads, 3, 'an idle pass reads nothing');
  } finally {
    runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a finished turn is searchable immediately, and an unchanged session is not re-parsed', async () => {
  const { history, runtime, cleanup } = fixture({
    sessions: { a1: [turn('m1', '先写一段关于缓存层的正文。')] },
  });
  try {
    runtime.sweep();
    assert.equal(runtime.findMessages({ text: '缓存层' }).length, 1);

    // The turn-end nudge: the session that just spoke, with no sweep in between.
    history.write('a1', [
      turn('m1', '先写一段关于缓存层的正文。'),
      turn('m2', '追加一轮：这次讲的是全文检索的任务关联。'),
    ]);
    await sleep(5);
    const synced = runtime.syncSession('a1');
    assert.equal(synced.sessionSkipped, false, 'the file moved, so this turn re-reads it');
    assert.equal(synced.inserted, 1, 'only the new chunk is written');
    assert.equal(runtime.findMessages({ text: '任务关联' }).length, 1,
      'the turn is searchable now, not at the next sweep');
    assert.equal(runtime.status().sweeps, 1, 'a per-turn sync is not a sweep');

    // Second nudge with nothing new: the mtime fast path answers without parsing.
    assert.equal(runtime.syncSession('a1').sessionSkipped, true);

    // A sweep is what drops a session history no longer has.
    history.deleteSession('a1');
    assert.equal(runtime.sweep().removedRefs, 1);
    assert.deepEqual(runtime.findMessages({ text: '全文检索' }), []);
  } finally {
    cleanup();
  }
});

test('message hits are reported as sessions, and the caller can exclude its own', () => {
  // Two sessions hit, three do not. The controls are not decoration: bm25's idf is
  // log((N-n+0.5)/(n+0.5)), which is exactly 0 whenever the term is in half the
  // corpus — a two-document fixture scores 0 for *any* query and would make the
  // score assertion below vacuous.
  const controls = Object.fromEntries(Array.from({ length: 3 }, (_, i) =>
    [`ctl-${i}`, [turn(`c${i}`, '这一段讲的是缓存层重构，和检索的排序无关。')]]));
  const { runtime, cleanup } = fixture({
    sessions: {
      mine: [turn('m1', '这一轮在讨论全文检索的实现细节。')],
      other: [turn('m2', '上一轮也在讨论全文检索，是另一个会话。')],
      ...controls,
    },
  });
  try {
    runtime.sweep();
    const all = runtime.findMessages({ text: '全文检索' });
    assert.deepEqual(all.map(hit => hit.sessionId).sort(), ['mine', 'other']);
    // The turn being judged is inside its own history, so self-retrieval is not
    // evidence — the classify path passes its own session id here.
    const withoutSelf = runtime.findMessages({ text: '全文检索', excludeRefIds: ['mine'] });
    assert.deepEqual(withoutSelf.map(hit => hit.sessionId), ['other']);
    assert.equal(withoutSelf[0].kind, 'user');
    assert.ok(withoutSelf[0].score > 0, 'bm25 is flipped so bigger is better');
    assert.equal(DEFAULT_HITS, 10, 'the port advertises a page of chunks by default');
    assert.equal(runtime.findMessages({ text: '全文检索', limit: 1 }).length, 1);
    assert.deepEqual(runtime.findMessages({ text: '' }), []);
    assert.deepEqual(runtime.findMessages({ text: '哎' }), [], 'a one-character query is weak, not a syntax error');
  } finally {
    cleanup();
  }
});

test('an index that is unavailable degrades the whole port instead of throwing', () => {
  const dir = tempDir();
  const runtime = createSearchRuntime({
    dataDir: dir,
    logger,
    intervalMs: 0,
    index: { available: false, reason: 'FTS5 不可用', dbFile: path.join(dir, 'search-index.sqlite'), close() {} },
  });
  try {
    assert.equal(runtime.available, false);
    assert.equal(runtime.reason, 'FTS5 不可用');
    assert.equal(runtime.start().status().available, false, 'start() on an unusable index is a no-op, not a crash');
    assert.equal(runtime.sweep(), null);
    assert.equal(runtime.syncSession('a1'), null);
    assert.deepEqual(runtime.findMessages({ text: '检索' }), []);
    assert.equal(runtime.status().warming, false);
    assert.equal(runtime.stats().available, false);
  } finally {
    runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing index is contained and counted, not propagated to the caller', () => {
  const boom = new Error('database is closed');
  const broken = {
    available: true,
    reason: '',
    dbFile: ':memory:',
    listRefs: () => [],
    readMarker: () => null,
    writeMarker: () => {},
    listMarkers: () => [],
    dropMarkers: () => 0,
    pruneRef: () => 0,
    upsert: () => { throw boom; },
    search: () => { throw boom; },
    stats: () => { throw boom; },
    close() {},
  };
  const { runtime, cleanup } = fixture({
    sessions: { a1: [turn('m1', '一轮正文，足够长到会被分块。')] },
    index: broken,
  });
  try {
    assert.equal(runtime.syncSession('a1'), null, 'a failing turn-end sync is not a failed turn');
    assert.deepEqual(runtime.findMessages({ text: '检索' }), []);
    assert.equal(runtime.search({ text: '检索' }).mode, 'error');
    assert.equal(runtime.stats().available, false);
    assert.ok(runtime.status().failures >= 3, 'failures are counted where a health check can see them');
  } finally {
    cleanup();
  }
});

test('the shared runtime is one instance per data directory, and can be reset', () => {
  const dir = tempDir();
  const other = tempDir();
  try {
    const first = getSharedSearchRuntime({ dataDir: dir, logger, intervalMs: 0 });
    assert.equal(getSharedSearchRuntime({ dataDir: dir, logger, intervalMs: 0 }), first,
      'two consumers in one process must not open two handles on the same file');
    assert.notEqual(getSharedSearchRuntime({ dataDir: other, logger, intervalMs: 0 }), first);
    assert.equal(first.status().started, true, 'a shared instance starts sweeping the moment it is handed out');
    assert.equal(first.dataDir, dir, 'the data directory is resolved once, at creation');

    resetSharedSearchRuntimes();
    const second = getSharedSearchRuntime({ dataDir: dir, logger, intervalMs: 0 });
    assert.notEqual(second, first, 'a reset memo is refilled with a fresh handle');
    resetSharedSearchRuntimes();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
