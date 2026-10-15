'use strict';

// Event rule engine: subscribes to the hub and runs matching rules.
// Rule sources: global rules (own JSON file) + session triggers of type:'event'
// (persisted.triggers). Guards: cooldown, fan-out cap, depth cap, and a
// self-inject latch so a turn the engine caused cannot re-trigger inject.

const { matchesAny } = require('./catalog');
const { ACTIONS } = require('./actions');
const { validateEventRule, matchesFilter } = require('./rules');

const MAX_FANOUT = 20;
const MAX_DEPTH = 2;
const MAX_GLOBAL_RULES = 100;
const TERMINAL = new Set(['task.finished', 'task.failed', 'task.waiting_user', 'task.waiting_background']);

function createEventRuleEngine(deps) {
  const { hub, persistedSessions, saveBestEffort } = deps;
  if (!hub || typeof hub.subscribe !== 'function') throw new TypeError('event engine dependency missing: hub');
  if (!(persistedSessions instanceof Map)) throw new TypeError('event engine dependency missing: persistedSessions');
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const logger = deps.logger || console;
  const idFactory = deps.idFactory || (() => require('crypto').randomUUID());
  const actionCtx = {
    now,
    notify: deps.notify || (() => false),
    injectPrompt: deps.injectPrompt || (() => false),
    createSession: deps.createSession || (async () => { throw new Error('no session factory'); }),
    sessionInfo: deps.sessionInfo || (() => null),
    resolveSecret: deps.resolveSecret || (() => null),
    lookup: deps.lookup || (async () => []),
    httpPost: deps.httpPost || (async () => { throw Object.assign(new Error('no transport'), { code: 'NO_TRANSPORT' }); }),
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    allowPrivateWebhooks: deps.allowPrivateWebhooks === true,
  };

  let globalRules = [];
  const lastFired = new Map();   // ruleId[:sessionId] -> ts
  const selfInjected = new Map(); // sessionId -> ruleId that injected
  const results = [];            // bounded recent run log
  let unsubscribe = null;

  function load() {
    try {
      const data = deps.store ? deps.store.read() : null;
      globalRules = Array.isArray(data && data.rules) ? data.rules : [];
    } catch (_) { globalRules = []; }
  }

  function persist() {
    if (deps.store) deps.store.write({ version: 1, rules: globalRules });
  }

  function record(entry) {
    results.push({ ts: now(), ...entry });
    if (results.length > 100) results.shift();
  }

  function rulesFor(event) {
    const out = globalRules.filter((rule) => rule.enabled).map((rule) => ({ rule, owner: null }));
    const persisted = event.sessionId ? persistedSessions.get(event.sessionId) : null;
    if (persisted && Array.isArray(persisted.triggers)) {
      for (const trigger of persisted.triggers) {
        if (trigger.enabled && trigger.type === 'event') out.push({ rule: trigger, owner: event.sessionId });
      }
    }
    return out;
  }

  function wants(rule, event) {
    if (event.type === 'trigger.fired') return rule.on.includes('trigger.fired');
    return matchesAny(rule.on, event.type);
  }

  async function execute(event, rule, owner) {
    const run = ACTIONS[rule.action.kind];
    const label = `${rule.id}:${rule.action.kind}`;
    try {
      const outcome = await run(event, rule, actionCtx);
      record({ ruleId: rule.id, kind: rule.action.kind, eventType: event.type, ok: outcome.ok, error: outcome.error || null });
      if (rule.action.kind === 'inject-prompt' && outcome.ok) selfInjected.set(outcome.target, rule.id);
      hub.emit('trigger.fired', event.sessionId, {
        ruleId: rule.id, actionKind: rule.action.kind, ok: outcome.ok, cause: event.type,
      }, { depth: event.depth + 1, origin: label });
      return outcome;
    } catch (error) {
      record({ ruleId: rule.id, kind: rule.action.kind, eventType: event.type, ok: false, error: 'action threw' });
      try { logger.warn && logger.warn('event_rule_action_failed', { ruleId: rule.id, error: String(error && error.message || error).slice(0, 120) }); } catch (_) {}
      return { ok: false };
    }
  }

  function onEvent(event) {
    if (event.depth >= MAX_DEPTH) return;
    // A terminal event of a turn this engine started must not re-run inject.
    let suppressInject = false;
    if (event.sessionId && TERMINAL.has(event.type) && selfInjected.has(event.sessionId)) {
      selfInjected.delete(event.sessionId);
      suppressInject = true;
    }
    let count = 0;
    for (const { rule, owner } of rulesFor(event)) {
      if (!wants(rule, event) || !matchesFilter(rule, event)) continue;
      if (owner && rule.filter && rule.filter.sessionIds && !rule.filter.sessionIds.includes(owner)) continue;
      if (suppressInject && rule.action.kind === 'inject-prompt') continue;
      const key = owner ? `${rule.id}:${owner}` : rule.id;
      const at = now();
      if (rule.cooldownMs > 0 && lastFired.has(key) && at - lastFired.get(key) < rule.cooldownMs) continue;
      if (++count > MAX_FANOUT) { record({ ruleId: rule.id, eventType: event.type, ok: false, error: 'fanout cap' }); break; }
      lastFired.set(key, at);
      if (owner) {
        const persisted = persistedSessions.get(owner);
        const live = persisted && persisted.triggers && persisted.triggers.find((item) => item.id === rule.id);
        if (live) { live.lastFiredAt = at; if (saveBestEffort) saveBestEffort('runtime.event-rule-fired'); }
      } else {
        rule.lastFiredAt = at;
      }
      execute(event, rule, owner);
    }
  }

  function start() {
    if (unsubscribe) return false;
    load();
    unsubscribe = hub.subscribe(onEvent);
    return true;
  }

  function stop() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    lastFired.clear();
    selfInjected.clear();
  }

  function addGlobal(body) {
    if (globalRules.length >= MAX_GLOBAL_RULES) return { error: 'too many global rules' };
    const validation = validateEventRule(body, { idFactory, nowIso: () => new Date(now()).toISOString(), scope: 'global' });
    if (validation.error) return validation;
    globalRules.push(validation.rule);
    persist();
    return validation;
  }

  function updateGlobal(id, body) {
    const index = globalRules.findIndex((rule) => rule.id === id);
    if (index < 0) return { error: 'not found', status: 404 };
    const validation = validateEventRule({ ...globalRules[index], ...body, id }, {
      idFactory, nowIso: () => globalRules[index].createdAt, scope: 'global',
    });
    if (validation.error) return validation;
    validation.rule.lastFiredAt = globalRules[index].lastFiredAt;
    globalRules[index] = validation.rule;
    persist();
    return validation;
  }

  function removeGlobal(id) {
    const next = globalRules.filter((rule) => rule.id !== id);
    if (next.length === globalRules.length) return false;
    globalRules = next;
    persist();
    return true;
  }

  return Object.freeze({
    start, stop, load, addGlobal, updateGlobal, removeGlobal,
    listGlobal: () => globalRules.map((rule) => ({ ...rule })),
    // Every event rule (global + all sessions) with its last run, for the UI list.
    listAll() {
      const lastRun = new Map();
      for (const run of results) lastRun.set(run.ruleId, run);
      const view = (rule, owner, label) => ({
        scope: owner ? 'session' : 'global', sessionId: owner || null, sessionLabel: label || null,
        rule: { ...rule }, lastRun: lastRun.get(rule.id) || null,
      });
      const items = globalRules.map((rule) => view(rule, null, null));
      for (const [id, persisted] of persistedSessions) {
        if (!Array.isArray(persisted.triggers)) continue;
        for (const trigger of persisted.triggers) {
          if (trigger.type === 'event') items.push(view(trigger, id, persisted.label || id));
        }
      }
      return items;
    },
    recentResults: () => results.slice(),
    // exposed for tests / manual-test route
    handle: onEvent,
    forgetSession: (sessionId) => { selfInjected.delete(sessionId); },
  });
}

module.exports = { createEventRuleEngine, MAX_FANOUT, MAX_DEPTH };
