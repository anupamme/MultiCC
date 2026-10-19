'use strict';

// 请求预算只在上游推理请求准入后启动，不包含工具执行和队列等待。
function bounded(value, fallback, min, max) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

function resolveModelRequestPolicy(session = {}, env = process.env) {
  const deep = /^(high|xhigh|max|ultra|ultracode)$/i.test(String(session.effort || ''));
  const legacy = session.providerSelection?.mode === 'auto' ? env.MULTICC_AUTO_STALL_TIMEOUT_MS : undefined;
  const stallTimeoutMs = bounded(env.MULTICC_MODEL_IDLE_TIMEOUT_MS ?? legacy,
    deep ? 600_000 : 300_000, 0, 600_000);
  return Object.freeze({
    stallTimeoutMs: stallTimeoutMs > 0 ? Math.max(15_000, stallTimeoutMs) : 0,
    requestTimeoutMs: bounded(env.MULTICC_MODEL_REQUEST_TIMEOUT_MS, deep ? 1_800_000 : 900_000, 30_000, 3_600_000),
    connectTimeoutMs: bounded(env.MULTICC_MODEL_CONNECT_TIMEOUT_MS, 30_000, 1_000, 120_000),
  });
}

module.exports = { resolveModelRequestPolicy };
