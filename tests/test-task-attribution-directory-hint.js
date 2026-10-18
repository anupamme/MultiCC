'use strict';

// directoryHint: the optional "this work belongs in another directory" half of
// an attribution verdict. It is parsed with the same trust boundary as task
// ids (only ids the prompt offered, never the current directory), journalled
// through attribution-decisions, and broadcast as a suggestion. Nothing in this
// path may move a task by itself — the user confirms through the existing
// POST /api/task-board/tasks/:taskId/relocate route.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/task-shell');
const { createTaskOperations } = require('../src/task-shell/task-operations');
const { createAttributionDecisions } = require('../src/task-shell/attribution-decisions');
const {
  buildTaskAttributionSystemPrompt,
  parseTaskAttribution,
  DIRECTORY_HINT_LIMIT,
} = require('../src/classify/task-attribution');

const DIRECTORIES = [
  { id: 'dir-web', name: 'Web 前端', path: '/repos/company/web' },
  { id: 'dir-api', name: 'API 服务', path: '/repos/company/api' },
];

const hint = { dirId: 'dir-api', reason: '代码与交付物属于 API 仓库' };

test('the prompt lists directories with a token budget and gates hints to new/first turns', () => {
  const prompt = buildTaskAttributionSystemPrompt({
    directories: DIRECTORIES, currentDirId: 'dir-web', firstTurn: false,
  });
  assert.match(prompt, /- dir-api: API 服务（company\/api）/);
  assert.match(prompt, /- dir-web: Web 前端（company\/web）（当前）/);
  assert.match(prompt, /拿不准必须填 null/);
  assert.match(prompt, /不得指向当前目录（dir-web）/);
  assert.match(prompt, /dirId 必须来自上面的清单/);
  assert.match(prompt, /只有\s*relation=new\s*时才产出/);
  assert.match(prompt, /"directoryHint":\{"dirId"/,
    'the JSON contract has to ask for the field or the model never answers it');

  const firstTurn = buildTaskAttributionSystemPrompt({
    directories: DIRECTORIES, currentDirId: 'dir-web', firstTurn: true,
  });
  assert.match(firstTurn, /只有\s*relation=new\s*或本轮是首轮工作时才产出/);

  // No list at all (older host composition): no section, and an explicit null
  // instruction, so a stale model answer cannot invent a directory.
  const without = buildTaskAttributionSystemPrompt({});
  assert.match(without, /没有可用的目录清单，directoryHint 一律填 null/);
  assert.doesNotMatch(without, /已注册目录/);
});

test('the directory list is capped and each entry is truncated', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `dir-${index}`, name: `${'很长的目录名'.repeat(20)}${index}`, path: `/repos/${index}`,
  }));
  const prompt = buildTaskAttributionSystemPrompt({ directories: many, currentDirId: 'dir-0' });
  assert.match(prompt, new RegExp(`- dir-${DIRECTORY_HINT_LIMIT - 1}:`));
  assert.doesNotMatch(prompt, new RegExp(`- dir-${DIRECTORY_HINT_LIMIT}:`),
    'the prompt budget is the cap, not the board size');
  assert.ok(!prompt.includes(many[1].name), 'a long name is truncated');
  assert.match(prompt, /很长的目录名/, 'the recognisable prefix survives');
});

test('a parsed hint must be offered, justified, and not the current directory', () => {
  const options = { allowedDirIds: DIRECTORIES.map(dir => dir.id), currentDirId: 'dir-web' };
  const json = value => JSON.stringify({ taskName: 'API 限流', relation: 'new', ...value });

  assert.deepEqual(parseTaskAttribution(json({ directoryHint: hint }), options).directoryHint, hint);
  assert.equal(parseTaskAttribution(json({
    directoryHint: { dirId: 'dir-ghost', reason: '不在清单里' },
  }), options).directoryHint, undefined, 'an id the model was not offered is dropped');
  assert.equal(parseTaskAttribution(json({
    directoryHint: { dirId: 'dir-web', reason: '已经是当前目录' },
  }), options).directoryHint, undefined, 'pointing at the current directory is dropped');
  assert.equal(parseTaskAttribution(json({
    directoryHint: { dirId: 'dir-api', reason: '   ' },
  }), options).directoryHint, undefined, 'a hint without a reason is not actionable');
  assert.equal(parseTaskAttribution(json({ directoryHint: 'dir-api' }), options).directoryHint, undefined);
  assert.equal(parseTaskAttribution(json({ directoryHint: hint })).directoryHint, undefined,
    'without an offered list there is nothing to validate against, so nothing is accepted');
});

test('a continuation never carries a hint; a first turn may', () => {
  const options = { allowedDirIds: DIRECTORIES.map(dir => dir.id), currentDirId: 'dir-web' };
  const continuation = JSON.stringify({
    taskName: '继续改 API', relation: 'same', taskId: 'tsk-api', directoryHint: hint,
  });
  assert.equal(parseTaskAttribution(continuation, options).directoryHint, undefined);
  assert.deepEqual(parseTaskAttribution(continuation, { ...options, firstTurn: true }).directoryHint, hint);

  // Legacy three-line output has no directory contract and keeps its old shape.
  const legacy = parseTaskAttribution('登录页样式调整\n验证中\nD', { fallbackTaskId: 'tsk-web' });
  assert.equal(legacy.directoryHint, undefined);
  assert.equal(Object.hasOwn(legacy, 'directoryHint'), false);
});

async function setup(t, { mode = 'suggest', turnId = 'turn-1' } = {}) {
  const f = fixture(t);
  f.runtime.adopt(f.a.id, 'a');
  const first = await f.runtime.send(f.a.id, { clientMsgId: 'work', text: 'work' });
  const histories = new Map([['a', [{ id: 'a:m1', sourceSessionId: 'a', sourceMessageId: 'm1',
    turnId, taskId: first.taskId, role: 'user', content: 'work' }]]]);
  const overlay = createTaskOperations({
    store: f.store, revisionOf: () => 'rev-1', isTurnBusy: () => false,
    resolveTarget: async (_scope, taskId) => f.store.get('task', taskId),
    taskTitle: taskId => f.store.get('task', taskId)?.title || null,
    effectiveTaskOf: (sessionId, id) => (histories.get(sessionId) || []).find(m => m.turnId === id)?.taskId ?? null,
  });
  const events = [];
  const decisions = createAttributionDecisions({
    store: f.store, operations: overlay,
    scopeOf: () => f.runtime.chatScope(f.a.id),
    settleAttribution: (...args) => f.runtime.settleAttribution(...args),
    restoreSettledCursor: (...args) => f.runtime.restoreSettledCursor(...args),
    isTurnBusy: () => false,
    taskTitle: taskId => f.store.get('task', taskId)?.title || null,
    onAttributionChanged: (sessionId, detail) => events.push({ sessionId, ...detail }),
  });
  const record = (extra = {}) => decisions.record('a', first.receiptId, {
    mode, relation: 'new', taskId: 'tsk_hint', taskName: 'API 限流', turnId, ...extra,
  });
  return { f, first, decisions, events, record, shellId: f.a.id };
}

test('a hint is journalled with the verdict and exposed to clients, without moving anything', async t => {
  const { f, first, decisions, events, shellId, record } = await setup(t);
  const result = await record({ directoryHint: hint });
  assert.equal(result.action, 'suggest');
  assert.deepEqual(result.decision.directoryHint, hint);
  assert.equal(result.decision.path, 'identity');
  assert.equal(f.store.get('task', first.taskId).dirId, 'd1',
    'recording a hint never relocates the task');
  assert.deepEqual(decisions.list(shellId)[0].directoryHint, hint);
  assert.deepEqual(events.find(event => event.kind === 'recorded').directoryHint, hint,
    'the broadcast carries the hint so another page can offer the move');
});

test('an ignored task/directory pair is not proposed again, and open ones are not duplicated', async t => {
  const { decisions, shellId, record } = await setup(t);
  const first = await record({ directoryHint: hint, turnId: 'turn-1' });
  assert.ok(first.decision.directoryHint);

  // A second turn of the same task while the first card is still open: no
  // second prompt for the same move.
  const duplicate = await record({ directoryHint: hint, turnId: 'turn-2' });
  assert.equal(duplicate.decision.directoryHint, null);

  decisions.dismiss(shellId, first.decision.id);
  const afterIgnore = await record({ directoryHint: hint, turnId: 'turn-3' });
  assert.equal(afterIgnore.decision.directoryHint, null,
    'the user already said no to this task/directory pair');
});

test('a first-turn conversation can carry a hint-only suggestion that still needs the user', async t => {
  const { decisions, shellId, record } = await setup(t);
  // relation=same with no target: there is no attribution change to journal,
  // so the hint gets its own address-less row.
  const result = await record({ relation: 'same', taskId: null, directoryHint: hint });
  assert.equal(result.action, 'suggest');
  assert.equal(result.decision.path, 'none');
  assert.equal(result.decision.toTaskId, null);
  assert.deepEqual(result.decision.directoryHint, hint);
  // Accepting an attribution row cannot apply a move; the client confirms the
  // relocate through the task-board route instead.
  await assert.rejects(decisions.accept(shellId, result.decision.id, { clientMsgId: 'accept-none' }),
    { code: 'attribution_verdict_unavailable' });
});

test('the mode ladder also governs hints: off is silent, shadow is hidden, auto never moves', async t => {
  const off = await setup(t, { mode: 'off' });
  assert.equal((await off.record({ directoryHint: hint })).action, 'none');
  assert.deepEqual(off.decisions.list(off.shellId, { includeHidden: true }), []);

  const shadow = await setup(t, { mode: 'shadow' });
  await shadow.record({ relation: 'same', taskId: null, directoryHint: hint });
  assert.deepEqual(shadow.decisions.list(shadow.shellId), [], 'shadow hints are not shown');
  assert.equal(shadow.decisions.list(shadow.shellId, { includeHidden: true })[0].directoryHint.dirId, 'dir-api');

  const auto = await setup(t, { mode: 'auto' });
  const applied = await auto.record({ directoryHint: hint });
  assert.equal(applied.action, 'apply');
  assert.equal(auto.f.store.get('task', auto.first.taskId).dirId, 'd1',
    'auto applies the identity change only; the move stays a suggestion');
  assert.equal(auto.decisions.list(auto.shellId).find(row => row.id === applied.decision.id).directoryHint.dirId, 'dir-api');
});
