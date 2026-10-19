'use strict';

// 保留旧配置入口；所有托管会话现在使用公共模型请求策略。
const { resolveModelRequestPolicy } = require('./model-request-policy');
const DEFAULT_AUTO_STALL_TIMEOUT_MS = 300_000;
const MIN_AUTO_STALL_TIMEOUT_MS = 15_000;
const MAX_AUTO_STALL_TIMEOUT_MS = 600_000;

function parseAutoStallTimeoutMs(value, fallback = DEFAULT_AUTO_STALL_TIMEOUT_MS) {
  const text = value == null ? '' : String(value).trim();
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number)) return fallback;
  const ms = Math.trunc(number);
  // An explicit zero or negative budget disables the watchdog; anything else is
  // clamped so a typo cannot retire a healthy line in seconds or hold a dead one
  // for an hour.
  if (ms <= 0) return 0;
  return Math.min(MAX_AUTO_STALL_TIMEOUT_MS, Math.max(MIN_AUTO_STALL_TIMEOUT_MS, ms));
}

function autoStallTimeoutFromEnv(env = process.env) {
  return parseAutoStallTimeoutMs(env && env.MULTICC_AUTO_STALL_TIMEOUT_MS);
}

function isAutoProviderSession(session) {
  const selection = session && session.providerSelection;
  return !!(selection && selection.mode === 'auto');
}

function resolveAutoStallTimeoutMs(session, env = process.env) {
  return resolveModelRequestPolicy(session || {}, env).stallTimeoutMs;
}

module.exports = {
  DEFAULT_AUTO_STALL_TIMEOUT_MS,
  MAX_AUTO_STALL_TIMEOUT_MS,
  MIN_AUTO_STALL_TIMEOUT_MS,
  autoStallTimeoutFromEnv,
  isAutoProviderSession,
  parseAutoStallTimeoutMs,
  resolveAutoStallTimeoutMs,
};
