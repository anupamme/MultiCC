'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createErrorPersister, isRecoverableReconnect } = require('../src/chat/error-persistence');

function setup(extra = {}) {
  const appended = [];
  const clock = { t: 1000 };
  const persister = createErrorPersister({
    appendChatMessage: (id, m) => { appended.push({ id, m }); return true; },
    now: () => clock.t,
    ...extra,
  });
  return { appended, clock, persister };
}

test('an error event is written to history as a system message and keyed for replay', () => {
  const { appended, persister } = setup();
  const out = persister.annotate('s1', { type: 'error', error: 'Codex 出错：404 model not found', code: 'upstream' });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, 's1');
  assert.equal(appended[0].m.role, 'system');
  assert.equal(appended[0].m.content, 'Error: Codex 出错：404 model not found');
  assert.equal(appended[0].m.errorEvent, true);
  assert.equal(appended[0].m.errorCode, 'upstream');
  assert.match(out.errorClientMsgId, /^err-[0-9a-f]{16}$/);
  assert.equal(appended[0].m.clientMsgId, out.errorClientMsgId);
});

test('non-error events, empty errors and transient reconnects are not persisted', () => {
  const { appended, persister } = setup();
  const result = { type: 'result' };
  assert.equal(persister.annotate('s1', result), result);
  persister.annotate('s1', { type: 'error', error: '   ' });
  persister.annotate('s1', { type: 'error', error: 'Codex 出错：Reconnecting... 1/5' });
  persister.annotate('s1', { type: 'error', error: 'Codex 出错：Reconnecting... 2/5 (stream disconnected before completion)' });
  assert.equal(appended.length, 0);
  assert.equal(isRecoverableReconnect('boom'), false);
});

test('the same error inside the window is stored once and reuses its key', () => {
  const { appended, clock, persister } = setup();
  const a = persister.annotate('s1', { type: 'error', error: 'x' });
  clock.t += 2000;
  const b = persister.annotate('s1', { type: 'error', error: 'x' });
  assert.equal(appended.length, 1);
  assert.equal(b.errorClientMsgId, a.errorClientMsgId);
  // a different session, or the same text after the window, is a new record
  persister.annotate('s2', { type: 'error', error: 'x' });
  clock.t += 20_000;
  persister.annotate('s1', { type: 'error', error: 'x' });
  assert.equal(appended.length, 3);
});

test('a failed append never breaks the broadcast and carries no key', () => {
  const payload = { type: 'error', error: 'x' };
  const refused = createErrorPersister({ appendChatMessage: () => false }).annotate('s1', payload);
  assert.equal(refused, payload);
  const thrown = createErrorPersister({ appendChatMessage: () => { throw new Error('disk'); } }).annotate('s1', payload);
  assert.equal(thrown, payload);
});
