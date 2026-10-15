'use strict';

// The rate-limit windows chatgpt.com/backend-api/wham/usage reports, classified
// by LENGTH into the bar's window tokens (5h / 1wk / 1m).
//
// The endpoint names its windows primary/secondary, but which slot holds which
// cycle is plan-dependent: Plus puts the 5h window in primary and the weekly
// one in secondary; prolite has only a 7-day window, in primary. So the slot
// name is never trusted — only limit_window_seconds is.
//
// Shared by the turn-boundary poller (src/usage-limit-poller.js) and the
// click-to-refresh route (src/routes/codex-quota.js), so the passive bar and
// the clicked bar can not disagree about which window is which.

const WEEKLY_MIN_WINDOW_SECONDS = 24 * 60 * 60;
const MONTHLY_MIN_WINDOW_SECONDS = 28 * 24 * 60 * 60;
const WINDOW_ORDER = Object.freeze({ '5h': 0, '1wk': 1, '1m': 2 });

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function windowToken(seconds) {
  if (seconds >= MONTHLY_MIN_WINDOW_SECONDS) return '1m';
  if (seconds >= WEEKLY_MIN_WINDOW_SECONDS) return '1wk';
  return '5h';
}

// rl = body.rate_limit → [{ window, label, usedPercent (0..100), windowSeconds,
// resetsAt (epoch seconds | null), resetMs (epoch ms | null) }], short → long.
// reset_at is absolute; reset_after_seconds is anchored to nowMs when it is the
// only stamp present.
function codexRateLimitWindows(rl, nowMs = Date.now()) {
  if (!rl || typeof rl !== 'object') return [];
  const rows = [];
  for (const w of [rl.primary_window, rl.secondary_window]) {
    if (!w || typeof w !== 'object') continue;
    const usedPercent = finite(w.used_percent);
    const windowSeconds = finite(w.limit_window_seconds);
    if (usedPercent === null || windowSeconds === null || windowSeconds <= 0) continue;
    let resetsAt = finite(w.reset_at);
    if (resetsAt === null) {
      const after = finite(w.reset_after_seconds);
      resetsAt = after !== null ? Math.trunc(nowMs / 1000) + after : null;
    }
    const window = windowToken(windowSeconds);
    rows.push({
      window,
      label: window,
      usedPercent,
      windowSeconds,
      resetsAt,
      resetMs: resetsAt !== null ? resetsAt * 1000 : null,
    });
  }
  return rows.sort((a, b) => (WINDOW_ORDER[a.window] - WINDOW_ORDER[b.window])
    || (a.windowSeconds - b.windowSeconds));
}

// The window a single-window reading reports: the weekly cap when the plan has
// one (it is the cycle that ends a week of work), else the longest there is.
function headlineWindow(windows) {
  if (!Array.isArray(windows) || !windows.length) return null;
  return windows.find((w) => w.window === '1wk') || windows[windows.length - 1];
}

module.exports = {
  codexRateLimitWindows,
  headlineWindow,
  WEEKLY_MIN_WINDOW_SECONDS,
};
