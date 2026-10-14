'use strict';

// Event rule schema: validation, normalization and filter matching. Pure.
// A rule = which events (`on`) + optional `filter` + one `action`.
// The same shape is used for session-level triggers (type:'event') and for
// global rules; only the storage differs.

const { isKnownPattern } = require('./catalog');

const ACTION_KINDS = Object.freeze(['inject-prompt', 'webhook', 'notify']);
const MAX_PATTERNS = 10;
const MAX_FILTER_IDS = 50;
const MIN_INJECT_COOLDOWN_MS = 10000;

function clampInt(value, min, max, fallback) {
  const number = parseInt(value, 10);
  if (Number.isNaN(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function textField(value, max) {
  return value == null ? '' : String(value).slice(0, max);
}

function idList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(String).filter((item) => /^[A-Za-z0-9._:-]{1,128}$/.test(item)).slice(0, MAX_FILTER_IDS);
}

// Webhook URL syntax check. Private/loopback rejection happens at send time
// (after DNS resolution) in actions.js; this only rejects obviously bad input.
function validateWebhookUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch (_) { return 'invalid webhook url'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'webhook url must be http(s)';
  if (url.username || url.password) return 'webhook url must not embed credentials';
  return null;
}

function validateAction(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'action is required' };
  const kind = String(raw.kind || '');
  if (!ACTION_KINDS.includes(kind)) return { error: `unknown action kind (${ACTION_KINDS.join('|')})` };
  const action = { kind };
  if (kind === 'inject-prompt') {
    action.prompt = textField(raw.prompt, 4000);
    if (raw.targetSessionId) {
      const [target] = idList(raw.targetSessionId);
      if (!target) return { error: 'invalid targetSessionId' };
      action.targetSessionId = target;
    }
  } else if (kind === 'webhook') {
    const problem = validateWebhookUrl(raw.url);
    if (problem) return { error: problem };
    action.url = String(raw.url).slice(0, 2000);
    if (raw.secretName != null && raw.secretName !== '') {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(raw.secretName))) return { error: 'invalid secretName' };
      action.secretName = String(raw.secretName);
    }
  } else {
    action.message = textField(raw.message, 400);
  }
  return { action };
}

// body: raw request/object. Returns { rule } or { error }.
function validateEventRule(body = {}, { idFactory, nowIso, scope = 'global' } = {}) {
  const on = (Array.isArray(body.on) ? body.on : (body.on ? [body.on] : [])).map(String);
  if (!on.length || on.length > MAX_PATTERNS) return { error: `on requires 1-${MAX_PATTERNS} event patterns` };
  const unknown = on.find((pattern) => !isKnownPattern(pattern));
  if (unknown) return { error: `unknown event pattern: ${unknown.slice(0, 60)}` };
  const validated = validateAction(body.action);
  if (validated.error) return { error: validated.error };

  const filter = {};
  const source = body.filter && typeof body.filter === 'object' ? body.filter : {};
  const sessionIds = idList(source.sessionIds);
  const dirIds = idList(source.dirIds);
  if (sessionIds.length) filter.sessionIds = sessionIds;
  if (dirIds.length) filter.dirIds = dirIds;
  if (source.goalState === 'achieved' || source.goalState === 'interact') filter.goalState = source.goalState;
  if (typeof source.cancelled === 'boolean') filter.cancelled = source.cancelled;

  const injecting = validated.action.kind === 'inject-prompt';
  const rule = {
    id: body.id || idFactory(),
    type: 'event',
    scope,
    name: textField(body.name, 80),
    enabled: body.enabled !== false,
    on,
    filter,
    action: validated.action,
    cooldownMs: Math.max(
      injecting ? MIN_INJECT_COOLDOWN_MS : 0,
      clampInt(body.cooldownMs, 0, 86400000, injecting ? 60000 : 0),
    ),
    mode: 'inject',
    createdAt: body.createdAt || nowIso(),
  };
  return { rule };
}

function matchesFilter(rule, event) {
  const filter = rule.filter || {};
  if (filter.sessionIds && !filter.sessionIds.includes(event.sessionId)) return false;
  if (filter.dirIds && !filter.dirIds.includes(event.dirId)) return false;
  if (filter.goalState && event.data.goalState !== filter.goalState) return false;
  if (typeof filter.cancelled === 'boolean' && Boolean(event.data.cancelled) !== filter.cancelled) return false;
  return true;
}

module.exports = { ACTION_KINDS, MIN_INJECT_COOLDOWN_MS, validateEventRule, validateAction, validateWebhookUrl, matchesFilter };
