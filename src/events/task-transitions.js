'use strict';

// Pure derivation of standard task events from a taskState transition.
// `prev`/`next` are full taskState objects (before/after setTaskState).
// The classify letter is the only state source; goalState is the D sub-state,
// which may arrive with D (classify), after D (refine) or by hand (manual).

const { isGoalState, isTerminalLetter, isAbnormalLetter, isProcessingLetter } = require('../classify/vocab');

const LETTER_EVENT = Object.freeze({
  P: 'task.running',
  D: 'task.finished',
  W: 'task.waiting_user',
  B: 'task.waiting_background',
  E: 'task.failed',
});

const GOAL_EVENT = Object.freeze({
  achieved: 'task.achieved',
  interact: 'task.needs_interaction',
});

function letterOf(state) {
  const letter = state && typeof state.classifyState === 'string' ? state.classifyState : null;
  return letter && LETTER_EVENT[letter] ? letter : null;
}

function goalOf(state) {
  return state && isGoalState(state.goalState) ? state.goalState : null;
}

function baseData(next) {
  return {
    taskId: next.taskId || null,
    goal: next.goal || '',
    phase: next.phase || 'idle',
    classifyState: letterOf(next),
    goalState: goalOf(next),
  };
}

// Returns an ordered array of { type, data }. Empty when nothing observable
// changed. Idempotency across calls is the hub's job (it owns the memory).
function deriveTaskEvents(prev, next) {
  const events = [];
  if (!next) return events;
  const before = letterOf(prev);
  const after = letterOf(next);
  const goalBefore = goalOf(prev);
  const goalAfter = goalOf(next);

  if (after && after !== before) {
    const data = { ...baseData(next), from: before };
    if (isAbnormalLetter(after)) {
      data.cancelled = Boolean(next.cancelledAt);
      data.cancelReason = next.cancelledAt ? (next.cancelReason || null) : null;
      data.errorCategory = next.apiError && next.apiError.category ? String(next.apiError.category) : null;
    }
    if (isProcessingLetter(after) && isTerminalLetter(before) && prev.taskId && next.taskId && prev.taskId !== next.taskId) {
      events.push({ type: 'task.restarted', data: { ...data, previousTaskId: prev.taskId } });
    }
    events.push({ type: LETTER_EVENT[after], data });
  }

  // goalState only means something while the letter is D.
  if (isTerminalLetter(after) && goalAfter && goalAfter !== (isTerminalLetter(before) ? goalBefore : null)) {
    let source = 'refine';
    if (!isTerminalLetter(before)) source = 'classify';
    else if (Number(next.goalStateManualAt || 0) !== Number((prev && prev.goalStateManualAt) || 0)) source = 'manual';
    const data = { ...baseData(next), from: isTerminalLetter(before) ? goalBefore : null, to: goalAfter, source };
    events.push({ type: 'task.goal_resolved', data });
    events.push({ type: GOAL_EVENT[goalAfter], data });
  }
  return events;
}

// Segment id used for idempotency: one task segment = one task id + start time.
function segmentKey(state) {
  return `${(state && state.taskId) || ''}@${(state && state.startedAt) || ''}`;
}

module.exports = { LETTER_EVENT, GOAL_EVENT, deriveTaskEvents, segmentKey, letterOf, goalOf };
