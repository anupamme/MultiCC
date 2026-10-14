'use strict';

// Standard event catalog. The single source of truth for event names, the
// aliases rules may subscribe to, and pattern matching. Pure: no I/O.
//
// Naming: `domain.verb`. Task events mirror the classify letter
// (src/classify/vocab.js) and never invent a second state source.

const TASK_EVENTS = Object.freeze([
  'task.running',             // P: a turn started / is running
  'task.finished',            // D entered (goalState may still be null)
  'task.goal_resolved',       // goalState of a D task changed (null->x, x->y)
  'task.achieved',            // derived: goalState became `achieved`
  'task.needs_interaction',   // derived: goalState became `interact`
  'task.waiting_user',        // W
  'task.waiting_background',  // B
  'task.failed',              // E (payload.cancelled tells user-stop from error)
  'task.restarted',           // a new task segment began after a D
]);

const TURN_EVENTS = Object.freeze(['turn.completed']);

const EVENT_TYPES = Object.freeze([...TASK_EVENTS, ...TURN_EVENTS, 'trigger.fired']);

// Aliases expand only at match time; they are never emitted themselves.
const ALIASES = Object.freeze({
  'task.attention': ['task.needs_interaction', 'task.waiting_user', 'task.failed'],
  'task.done': ['task.achieved', 'task.needs_interaction'],
});

const PATTERN_RE = /^(\*|[a-z_]+\.(?:\*|[a-z_]+))$/;

function isKnownPattern(pattern) {
  if (typeof pattern !== 'string' || !PATTERN_RE.test(pattern)) return false;
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const domain = pattern.slice(0, -2);
    return EVENT_TYPES.some((type) => type.startsWith(`${domain}.`));
  }
  return EVENT_TYPES.includes(pattern) || Object.prototype.hasOwnProperty.call(ALIASES, pattern);
}

function matchesPattern(pattern, type) {
  if (!isKnownPattern(pattern)) return false;
  if (pattern === '*' || pattern === type) return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  const alias = ALIASES[pattern];
  return Array.isArray(alias) && alias.includes(type);
}

function matchesAny(patterns, type) {
  return Array.isArray(patterns) && patterns.some((pattern) => matchesPattern(pattern, type));
}

module.exports = { TASK_EVENTS, TURN_EVENTS, EVENT_TYPES, ALIASES, isKnownPattern, matchesPattern, matchesAny };
