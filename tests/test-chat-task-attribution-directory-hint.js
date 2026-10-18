'use strict';

// The directory half of an attribution verdict. The server only records the
// suggestion; this controller is where the user confirms it. A hint-only row
// goes straight to relocate, an identity row accepts its attribution first,
// and a busy task keeps the card in place for a later retry.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../public/chat-task-attribution');

class FakeNode {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.hidden = false;
    this.className = ''; this.textContent = ''; this.title = ''; this.value = ''; this.disabled = false;
    this.classList = { values: new Set(),
      add: (...v) => v.forEach(x => this.classList.values.add(x)),
      remove: (...v) => v.forEach(x => this.classList.values.delete(x)),
      toggle: (v, on) => { if (on) this.classList.values.add(v); else this.classList.values.delete(v); },
      contains: v => this.classList.values.has(v) };
    this.attributes = {}; this.listeners = {}; this.parentNode = null;
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  insertBefore(node, before) {
    // Real DOM insertBefore moves an existing node instead of cloning it, and
    // insertBefore(node, node) is a no-op (no move at all).
    if (before === node) return;
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(c => c !== node);
    node.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index < 0 ? null : this.parentNode.children[index + 1] || null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index <= 0 ? null : this.parentNode.children[index - 1];
  }
  remove() { const parent = this.parentNode; this.removed = true; if (parent) parent.children = parent.children.filter(c => c !== this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelectorAll(selector) {
    if (selector === '.msg[data-msg-id][data-turn-id]') {
      return this.children.filter(node => node.className === 'msg' && node.dataset.msgId && node.dataset.turnId);
    }
    return [];
  }
}

function fixture() {
  const messages = new FakeNode('section'), body = new FakeNode('body');
  const doc = { body, createElement: tag => new FakeNode(tag), addEventListener() {} };
  return { messages, doc, body };
}

function turn(owner, turnId, taskId, code) {
  const node = new FakeNode('article');
  node.className = 'msg';
  node.dataset = { msgId: `${owner}:${turnId}:u`, sourceSessionId: owner, turnId, taskId, taskShortCode: code, taskName: `${code} task` };
  return node;
}

const MESSAGES = {
  taskAttributionDirHint: '更适合放在「{dir}」：{reason}',
  taskAttributionDirMove: '迁移过去',
  taskAttributionDismiss: '忽略',
  taskAttributionDismissed: '已忽略这条建议',
  airErrTaskBusy: '任务正在执行或排队中，等它空闲下来再操作。',
  airErrActionFailed: '操作失败',
  airMoveDone: '任务已移动到 {dir}{carried}。',
};
const translate = key => MESSAGES[key] || key;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const DIRECTORY = { id: 'dir-api', name: 'API 服务', path: '/repos/company/api' };

function hintDecision(extra = {}) {
  return {
    id: 'dec_hint', shellId: 'sh_1', sessionId: 's1', turnId: 't1',
    fromTaskId: 'tsk_web', toTaskId: null, toTaskTitle: null,
    path: 'none', state: 'pending',
    directoryHint: { dirId: 'dir-api', reason: '代码与交付物属于 API 仓库' },
    ...extra,
  };
}

function controllerFor(extra = {}) {
  const f = fixture();
  const calls = [];
  const relocated = [];
  let decisions = extra.decisions || [hintDecision()];
  const controller = createController({
    document: f.doc, messagesEl: f.messages, translate,
    scope: async () => ({ shellId: 'sh_1' }),
    loadSuggestions: async () => ({ decisions: decisions.map(item => ({ ...item })) }),
    loadDirectories: async () => [DIRECTORY],
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.includes('/attribution-decisions/') && path.endsWith('/accept')) {
        decisions = decisions.map(item => item.id === 'dec_hint' ? { ...item, state: 'applied' } : item);
        return { id: 'dec_hint', state: 'applied', toTaskId: 'tsk_api' };
      }
      if (path.includes('/attribution-decisions/') && path.endsWith('/dismiss')) {
        decisions = decisions.map(item => item.id === 'dec_hint' ? { ...item, state: 'dismissed' } : item);
        return { id: 'dec_hint', state: 'dismissed' };
      }
      if (path.includes('/relocate')) {
        if (extra.relocateError) throw extra.relocateError;
        return { ok: true, task: { id: body && 'tsk_api' }, dirId: 'dir-api', cwd: '/repos/company/api',
          carried: null, planned: false };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    onRelocated: payload => relocated.push(payload),
    makeId: () => 'attr-hint-1',
    ...extra.options,
  });
  return { f, calls, controller, relocated, setDecisions: next => { decisions = next; } };
}

test('a directory hint appears in the bar and next to its turn with the real directory name', async () => {
  const { f, controller } = controllerFor();
  f.messages.append(turn('s1', 't1', 'tsk_web', 'WEB1'));
  await settle(); await settle();
  const bar = f.doc.body.children[1];
  const proposals = bar.children[0];
  assert.equal(proposals.hidden, false);
  assert.equal(proposals.children.length, 1);
  const row = proposals.children[0];
  assert.equal(row.dataset.decision, 'dec_hint');
  assert.equal(row.dataset.dirId, 'dir-api');
  assert.equal(row.children[0].textContent,
    '更适合放在「API 服务」：代码与交付物属于 API 仓库',
    'the directory name comes from the page directory list, not the raw id');
  assert.deepEqual(row.children.slice(1).map(node => node.textContent), ['迁移过去', '忽略']);

  const card = f.messages.children[1];
  assert.equal(card.className, 'task-attribution-inline');
  assert.equal(card.dataset.decision, 'dec_hint');
  assert.match(card.children[0].textContent, /API 服务/);
  assert.deepEqual(card.children.slice(1).map(node => node.textContent), ['迁移过去', '忽略']);
  controller.dispose();
});

test('moving a hint-only row relocates the source task and dismisses the decision', async () => {
  const { f, calls, controller, relocated } = controllerFor();
  f.messages.append(turn('s1', 't1', 'tsk_web', 'WEB1'));
  await settle(); await settle();
  const card = f.messages.children[1];
  card.children[1].onclick();
  await settle(); await settle();

  const relocate = calls.find(call => call.path.includes('/relocate'));
  assert.ok(relocate, 'the user confirmation is what calls relocate');
  assert.equal(relocate.path, '/api/task-board/tasks/tsk_web/relocate');
  assert.equal(relocate.body.dirId, 'dir-api');
  const dismiss = calls.find(call => call.path.endsWith('/dismiss'));
  assert.equal(dismiss.path, '/api/task-shells/sh_1/attribution-decisions/dec_hint/dismiss');
  assert.equal(calls.some(call => call.path.endsWith('/accept')), false,
    'a path:none row has no attribution verdict to accept');
  assert.deepEqual(relocated, [{ dirId: 'dir-api', taskId: 'tsk_web',
    result: { ok: true, task: { id: 'tsk_api' }, dirId: 'dir-api', cwd: '/repos/company/api', carried: null, planned: false } }]);
  const toast = f.doc.body.children.find(node => node.className === 'task-attribution-toast');
  assert.equal(toast.children[0].textContent, '任务已移动到 API 服务。');
  assert.equal(f.messages.children.length, 1, 'the card leaves with the resolved decision');
  controller.dispose();
});

test('an identity row accepts its attribution before relocating the task', async () => {
  const decision = hintDecision({ path: 'identity', toTaskId: 'tsk_api', toTaskTitle: 'API 限流' });
  const { f, calls, controller, relocated } = controllerFor({ decisions: [decision] });
  f.messages.append(turn('s1', 't1', 'tsk_web', 'WEB1'));
  await settle(); await settle();
  f.messages.children[1].children[1].onclick();
  await settle(); await settle();

  const ordered = calls.map(call => call.path);
  assert.deepEqual(ordered.slice(0, 2), [
    '/api/task-shells/sh_1/attribution-decisions/dec_hint/accept',
    '/api/task-board/tasks/tsk_api/relocate',
  ], 'accept comes first, then the existing relocate route');
  assert.equal(calls[0].body.clientMsgId, 'attr-hint-1');
  assert.deepEqual(relocated.map(item => [item.dirId, item.taskId]), [['dir-api', 'tsk_api']]);
  controller.dispose();
});

test('ignoring a hint dismisses it and never moves the task', async () => {
  const { f, calls, controller, relocated } = controllerFor();
  f.messages.append(turn('s1', 't1', 'tsk_web', 'WEB1'));
  await settle(); await settle();
  f.messages.children[1].children[2].onclick();
  await settle(); await settle();
  assert.deepEqual(calls.map(call => call.path),
    ['/api/task-shells/sh_1/attribution-decisions/dec_hint/dismiss']);
  assert.deepEqual(relocated, []);
  assert.equal(f.doc.body.children[0].dataset.suggestions, '0');
  controller.dispose();
});

test('a busy task explains why and keeps the hint for a later retry', async () => {
  const busy = Object.assign(new Error('task_busy'), { code: 'task_busy' });
  const { f, calls, controller, relocated } = controllerFor({ relocateError: busy });
  f.messages.append(turn('s1', 't1', 'tsk_web', 'WEB1'));
  await settle(); await settle();
  f.messages.children[1].children[1].onclick();
  await settle(); await settle();

  assert.equal(calls.some(call => call.path.endsWith('/dismiss')), false,
    'a failed move must not consume the decision');
  assert.deepEqual(relocated, []);
  const summary = f.doc.body.children[1].children
    .find(node => node.className === 'task-attribution-summary');
  assert.equal(summary.textContent, MESSAGES.airErrTaskBusy);
  assert.equal(summary.dataset.tone, 'warn');
  assert.equal(f.messages.children.length, 2, 'the inline card stays in place');
  assert.equal(f.messages.children[1].className, 'task-attribution-inline');
  controller.dispose();
});

test('the same decision never renders twice, even when the queue repeats it', async () => {
  const decision = hintDecision();
  const { f, controller } = controllerFor({ decisions: [decision, { ...decision }, { ...decision, id: 'dec_other' }] });
  f.messages.append(turn('s1', 't1', 'tsk_web', 'WEB1'));
  await settle(); await settle();
  const proposals = f.doc.body.children[1].children[0];
  assert.deepEqual(proposals.children.map(row => row.dataset.decision), ['dec_hint', 'dec_other']);
  assert.equal(f.messages.children.filter(node => node.className === 'task-attribution-inline').length, 2,
    'two distinct decisions, one card each');
  await controller.refreshSuggestions();
  await settle();
  assert.deepEqual(f.doc.body.children[1].children[0].children.map(row => row.dataset.decision),
    ['dec_hint', 'dec_other'], 'a refresh does not duplicate the cards');
  controller.dispose();
});
