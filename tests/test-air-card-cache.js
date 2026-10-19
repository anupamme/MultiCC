'use strict';
// /api/air 的卡片底稿缓存（src/workspace/air-card-cache.js）。
// 背景：线上约 1270 张卡，每轮逐卡解析权属/资源/提醒约 200ms，而 7 成以上的轮次
// 最后回的是 304。缓存只能在「输入真的没变」时命中；随时间和运行时自己变的
// runState / worktreeChanges 必须每轮现算，不能被缓存冻住。
const test = require('node:test');
const assert = require('node:assert/strict');
const { mountAirRoutes } = require('../src/workspace/air-routes');
const { createAirCardCache } = require('../src/workspace/air-card-cache');
const { airResponse } = require('./helpers/air-response');

function fixture({ mode = 'on', verifyMs = 60_000, epoch = () => 'e1' } = {}) {
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  const now = Date.now();
  const board = { tasks: {
    tsk_1: { id: 'tsk_1', title: '任务一', status: 'active', chatSessionId: 's1',
      runState: 'running', runStateAt: now - 5 * 60_000, refs: [{ sessionId: 's1', dirId: 'd1', ts: now - 1000 }] },
    tsk_2: { id: 'tsk_2', title: '任务二', status: 'active', refs: [{ sessionId: 's2', dirId: 'd1', ts: now - 2000 }] },
  } };
  // s1 有受理物证（classifyState），所以 tsk_1 不会被当作「从没受理过」折成 idle；
  // 它的 runState 只取决于执行会话自己的队列状态（staleWorkerClaim）。
  const records = new Map([
    ['s1', { id: 's1', dirId: 'd1', kind: 'chat', cli: 'codex', provider: 'p1', taskState: { classifyState: 'P', goalState: null } }],
    ['s2', { id: 's2', dirId: 'd1', kind: 'chat', cli: 'codex' }],
  ]);
  const state = { accessCalls: 0, runState: 'running', merge: { ahead: '0', dirty: false } };
  const logs = [];
  const logger = { warn: (event, data) => logs.push({ event, ...data }), info: (event, data) => logs.push({ event, ...data }) };
  mountAirRoutes(app, {
    admission: { snapshot: () => ({ workspaces: [{ id: 'ws1', ownerId: 's1', residency: 'resident', path: '/wt', branch: 'b', pins: [] }],
      leases: [], budgets: { residentLimit: 4 } }), capacityReason: () => null },
    records, directories: new Map([['d1', { id: 'd1', name: 'Repo', path: '/repo' }]]),
    getBoard: () => board, clis: ['codex'], providerName: r => `线路-${r.provider}`,
    getSessionRunState: () => state.runState,
    mergeStateCached: () => state.merge,
    shell: { taskAccess: () => { state.accessCalls += 1; return { readOnly: false, status: 'active' }; }, readEpoch: () => epoch() },
    cardCache: createAirCardCache({ mode, verifyMs, logger }),
  });
  const get = async () => {
    const res = airResponse();
    await handlers.get('/api/air')({ headers: {} }, res);
    return { body: res.body, json: JSON.parse(res.body) };
  };
  return { get, board, records, state, logs };
}
const card = (json, id) => json.tasks.find(task => task.id === id);

test('输入没变时命中缓存：不再逐卡解析权属，正文逐字节不变', async () => {
  const f = fixture();
  const first = await f.get();
  assert.equal(f.state.accessCalls, 2);
  const second = await f.get();
  assert.equal(f.state.accessCalls, 2, '命中时不再逐卡调 taskAccess');
  assert.equal(second.body, first.body, '命中与现建吐出的正文必须相同');
});

test('命中缓存的那几轮，runState 与 worktreeChanges 仍是现算的', async () => {
  const f = fixture();
  const first = await f.get();
  assert.equal(card(first.json, 'tsk_1').runState, 'running');
  assert.deepEqual(card(first.json, 'tsk_1').worktreeChanges, { dirty: false, ahead: 0 });
  f.state.runState = 'idle';                       // 执行会话已经不在跑（过了派发宽限）
  f.state.merge = { ahead: '2', dirty: true };     // worktree 后台刷新出了新状态
  const second = await f.get();
  assert.equal(f.state.accessCalls, 2, '这两格变化不该让底稿重建');
  assert.equal(card(second.json, 'tsk_1').runState, 'idle');
  assert.deepEqual(card(second.json, 'tsk_1').worktreeChanges, { dirty: true, ahead: 2 });
});

test('任务板卡片被原地改写、会话记录被原地改写、任务库读数变化，都必须重建', async () => {
  const f = fixture();
  await f.get();
  f.board.tasks.tsk_2.title = '改过名';           // 原地改写，没有任何版本号
  assert.equal(card((await f.get()).json, 'tsk_2').title, '改过名');
  assert.equal(f.state.accessCalls, 4);
  f.records.get('s1').taskState.goalState = 'achieved';
  assert.equal(card((await f.get()).json, 'tsk_1').goalState, 'achieved');
  assert.equal(f.state.accessCalls, 6);
  f.records.get('s1').provider = 'p2';
  assert.equal(card((await f.get()).json, 'tsk_1').providerName, '线路-p2');
  assert.equal(f.state.accessCalls, 8);
});

test('任务库读数变了（权属可能变了）就重建；读数拿不到就绕过缓存', async () => {
  let epoch = 'e1';
  const f = fixture({ epoch: () => epoch });
  await f.get(); await f.get();
  assert.equal(f.state.accessCalls, 2);
  epoch = 'e2';
  await f.get();
  assert.equal(f.state.accessCalls, 4, '读数变化必须重建');
  epoch = null;
  await f.get(); await f.get();
  assert.equal(f.state.accessCalls, 8, '读数为 null 时每轮现建');
});

test('on 档：同一份缓存最多用 verifyMs，到点现建一次并比对', async () => {
  const f = fixture({ verifyMs: 0 });
  await f.get(); await f.get();
  assert.equal(f.state.accessCalls, 4, 'verifyMs=0 等于每轮都核对');
  assert.equal(f.logs.filter(line => line.event === 'air_card_cache_mismatch').length, 0, '签名完整时核对不出差异');
});

test('shadow 档永远现建；签名没变而内容变了时记下差异（签名漏输入的报警）', async () => {
  const f = fixture({ mode: 'shadow' });
  const first = await f.get();
  const second = await f.get();
  assert.equal(f.state.accessCalls, 4, 'shadow 档不省活');
  assert.equal(second.body, first.body);
  // 造一个签名覆盖不到的输入变化：taskAccess 的结果凭空变了，读数却没动。
  const handlers = new Map(), app = { get: (p, fn) => handlers.set(p, fn), post() {} };
  const logs = [];
  let readOnly = false;
  mountAirRoutes(app, {
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }), capacityReason: () => null },
    records: new Map(), directories: new Map(), getBoard: () => ({ tasks: { t: { id: 't', title: 'x', refs: [] } } }), clis: [],
    shell: { taskAccess: () => ({ readOnly }), readEpoch: () => 'same' },
    cardCache: createAirCardCache({ mode: 'shadow', logger: { warn: (event, data) => logs.push({ event, ...data }) } }),
  });
  const run = async () => { const res = airResponse(); await handlers.get('/api/air')({ headers: {} }, res); return JSON.parse(res.body); };
  await run();
  readOnly = true;
  assert.equal((await run()).tasks[0].readOnly, true, 'shadow 档返回的永远是现建结果');
  const mismatch = logs.find(line => line.event === 'air_card_cache_mismatch');
  assert.ok(mismatch, '必须记下差异');
  assert.equal(mismatch.taskId, 't');
  assert.deepEqual(mismatch.fields, ['readOnly']);
});

test('off 档与未知档位：off 永远现建；拼错的档位退回 shadow 而不是 on', () => {
  let builds = 0;
  const off = createAirCardCache({ mode: 'off' });
  off.resolve('s', () => { builds += 1; return []; });
  off.resolve('s', () => { builds += 1; return []; });
  assert.equal(builds, 2);
  assert.equal(createAirCardCache({ mode: 'yes' }).mode, 'shadow');
});
