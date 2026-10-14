'use strict';

// Event hub: wraps the central bus so every standard event shares one envelope
// {eventId, seq, ts, type, sessionId, dirId, data, depth, origin}.
//
// - observeTaskState() is the single bridge from setTaskState transitions.
// - Idempotency: a goal event fires once per (task segment, goalState) until
//   the session leaves D; a manual or refine write of the same value is a no-op.
// - Subscribers are isolated: a throwing subscriber never breaks the emitter
//   or its siblings.

const { deriveTaskEvents, segmentKey, letterOf } = require('./task-transitions');
const { EVENT_TYPES } = require('./catalog');
const { isTerminalLetter } = require('../classify/vocab');

const MAX_RECENT = 200;

function createEventHub(deps = {}) {
  const bus = deps.bus;
  if (!bus || typeof bus.on !== 'function' || typeof bus.emit !== 'function') {
    throw new TypeError('event hub dependency missing: bus');
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const randomUUID = deps.randomUUID || require('crypto').randomUUID;
  const logger = deps.logger || console;
  const resolveDir = typeof deps.dirIdOf === 'function' ? deps.dirIdOf : () => null;

  const subscribers = new Set();
  const goalMemory = new Map(); // sessionId -> `${segment}:${goalState}`
  const recent = [];
  let seq = 0;
  let started = false;

  function dispatch(event) {
    recent.push(event);
    if (recent.length > MAX_RECENT) recent.shift();
    for (const listener of [...subscribers]) {
      try { listener(event); }
      catch (error) {
        try { logger.warn && logger.warn('event_subscriber_failed', { type: event.type, error: String(error && error.message || error).slice(0, 120) }); } catch (_) {}
      }
    }
  }

  function emit(type, sessionId, data = {}, meta = {}) {
    if (!EVENT_TYPES.includes(type)) return null;
    const event = Object.freeze({
      eventId: randomUUID(),
      seq: ++seq,
      ts: now(),
      type,
      sessionId: sessionId || null,
      dirId: resolveDir(sessionId) || null,
      data: Object.freeze({ ...data }),
      // depth/origin let rule actions that cause new work be traced and capped.
      depth: Number.isInteger(meta.depth) ? meta.depth : 0,
      origin: meta.origin || null,
    });
    dispatch(event);
    return event;
  }

  function observeTaskState(sessionId, prev, next) {
    const emitted = [];
    let derived;
    try { derived = deriveTaskEvents(prev, next); }
    catch (error) { return emitted; }
    const after = letterOf(next);
    if (!isTerminalLetter(after)) goalMemory.delete(sessionId);
    for (const item of derived) {
      if (item.type === 'task.goal_resolved' || item.type === 'task.achieved' || item.type === 'task.needs_interaction') {
        const key = `${segmentKey(next)}:${item.type}:${item.data.to}`;
        const memo = goalMemory.get(sessionId) || new Set();
        if (memo.has(key)) continue;
        memo.add(key);
        goalMemory.set(sessionId, memo);
      }
      const event = emit(item.type, sessionId, item.data);
      if (event) emitted.push(event);
    }
    return emitted;
  }

  function onStateChanged(sessionId, prev, next) {
    try { observeTaskState(sessionId, prev, next); }
    catch (_) {}
  }

  function onTurnComplete(sessionId, _chat, completion) {
    if (!completion || completion.resultDurable !== true) return;
    emit('turn.completed', sessionId, { turnId: completion.turnId || null, lineageKind: completion.lineage && completion.lineage.kind || null });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  function start() {
    if (started) return false;
    started = true;
    bus.on('task:state-changed', onStateChanged);
    bus.on('chat:turn-complete', onTurnComplete);
    return true;
  }

  function stop() {
    if (!started) return;
    started = false;
    bus.off('task:state-changed', onStateChanged);
    bus.off('chat:turn-complete', onTurnComplete);
    subscribers.clear();
    goalMemory.clear();
  }

  function forgetSession(sessionId) { goalMemory.delete(sessionId); }

  return Object.freeze({
    emit, observeTaskState, subscribe, start, stop, forgetSession,
    recent: (limit = 50) => recent.slice(-Math.max(1, Math.min(limit, MAX_RECENT))),
  });
}

module.exports = { createEventHub };
