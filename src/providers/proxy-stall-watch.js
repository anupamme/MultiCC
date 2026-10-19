'use strict';

const { proxyRequestKind } = require('./proxy-outcome');

const { createModelStreamProgress } = require('./model-stream-progress');

// 每个已准入的模型请求独占计时器；请求结束即撤销，不计本地工具时间。
const RESPONSE_STALLED_BEFORE_RESPONSE = 'response_stalled_before_response';
const STREAM_IDLE_TIMEOUT = 'stream_idle_timeout';
const MODEL_REQUEST_DEADLINE = 'model_request_deadline';
const MODEL_CONNECT_TIMEOUT = 'model_connect_timeout';
const PROXY_STALL_CODES = Object.freeze([
  RESPONSE_STALLED_BEFORE_RESPONSE,
  STREAM_IDLE_TIMEOUT,
  MODEL_REQUEST_DEADLINE,
  MODEL_CONNECT_TIMEOUT,
]);

const PROXY_STALL_CODE_SET = new Set(PROXY_STALL_CODES);

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function isProxyStallCode(value) {
  return PROXY_STALL_CODE_SET.has(clean(value).toLowerCase());
}

function stallCodeFor(progressed) {
  return progressed ? STREAM_IDLE_TIMEOUT : RESPONSE_STALLED_BEFORE_RESPONSE;
}

function stallBody(code, timeoutMs) {
  const seconds = Math.max(1, Math.round(Number(timeoutMs) / 1000));
  return JSON.stringify({
    error: {
      type: 'upstream_stalled',
      code,
      message: code === MODEL_REQUEST_DEADLINE ? 'model request budget exhausted'
        : `upstream made no progress for ${seconds}s`,
    },
  });
}

// Retire a stalled downstream response.
//
// The socket is destroyed even when a 504 is written first, and that is not an
// accident: both provider proxies release the upstream request only when they
// see a client that walked away without finishing (`res.writableEnded` false).
// A polite `res.end()` would therefore leave the dead upstream socket open —
// exactly the resource this watchdog exists to give back — and would make the
// proxy's own `res.writeHead` throw when the provider finally answers. The
// explicit content-length makes the 504 a complete message for the CLI without
// the terminating chunk, so the client still reads a real HTTP error.
function terminateStalledResponse(res, { code, timeoutMs = 0, progressed = false } = {}) {
  if (!res) return false;
  const destroy = () => {
    if (typeof res.destroy === 'function') {
      res.destroy();
      return true;
    }
    if (typeof res.end === 'function') {
      res.end();
      return true;
    }
    return false;
  };
  if (!progressed) {
    const body = stallBody(code, timeoutMs);
    try {
      if (typeof res.writeHead === 'function') {
        res.writeHead(504, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          // The Anthropic SDK retries 4xx/5xx; this route has been proved dead.
          'x-should-retry': 'false',
        });
      }
      if (typeof res.write === 'function') res.write(body);
      else if (typeof res.end === 'function') res.end(body);
    } catch (_) {}
  }
  return destroy();
}

// 一个物理请求一个看门狗；重试继承同一请求链的绝对截止时间。
function createProxyStallWatch(options = {}) {
  const protocol = clean(options.protocol).toLowerCase();
  const res = options.res;
  const observe = options.observation;
  const requestKind = options.requestKind || proxyRequestKind(protocol, options.req);
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const unschedule = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const onStall = typeof options.onStall === 'function' ? options.onStall : null;
  const now = options.now || Date.now;
  const readProgress = createModelStreamProgress();
  let deadlineTimer = null;
  let deadlineAt = null;
  let freshDeadlineAt = null;
  let timer = null;
  let limitMs = 0;
  let connectMs = 0;
  let armed = false;
  let progressed = false;
  let finished = false;

  function disarm() {
    if (timer === null) return;
    unschedule(timer);
    timer = null;
  }

  function rearm() {
    disarm();
    if (finished || limitMs <= 0) return;
    timer = schedule(onTimeout, limitMs);
    // A watchdog can never be the reason the process stays alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function noteProgress() {
    if (finished) return;
    progressed = true;
    // 有效事件只重置空闲预算，不延长绝对截止时间。
    if (timer !== null) rearm();
  }

  function finish() {
    if (finished) return;
    finished = true;
    disarm();
    if (deadlineTimer !== null) unschedule(deadlineTimer);
    deadlineTimer = null;
  }

  function hasSentHeaders() {
    return progressed || res?.headersSent === true;
  }

  function onTimeout(forcedCode, timeoutMs = limitMs) {
    if (finished) return;
    const code = forcedCode || stallCodeFor(progressed);
    const detail = {
      code,
      timeoutMs,
      progressed,
      protocol,
      requestKind,
      sessionId: clean(options.sessionId) || null,
      providerId: clean(options.providerId) || null,
      role: clean(options.role) || null,
    };
    // 1. Settle FIRST. The teardown below closes the socket, which the host
    //    observes as DOWNSTREAM_DISCONNECT — a weaker cause that must never
    //    overwrite host-observed silence. It also carries the stall into the
    //    attempt runtime, which refuses to re-dial this route.
    try { observe.settle({ status: 'error', errorCode: code }); } catch (_) {}
    if (onStall) { try { onStall(detail); } catch (_) {} }
    // 2. Retire the route.
    finish();
    try { terminateStalledResponse(res, { code, timeoutMs, progressed: hasSentHeaders() }); } catch (_) {}
    return detail;
  }

  function arm(attempt) {
    if (armed || finished) return false;
    if (requestKind !== 'inference' || !res || !observe
        || typeof observe.settle !== 'function') return false;
    const budget = Number(attempt && attempt.stallTimeoutMs);
    const total = Number(attempt && attempt.requestTimeoutMs);
    if ((!Number.isSafeInteger(budget) || budget <= 0) && !(total > 0)) return false;
    armed = true;
    connectMs = Number(attempt.connectTimeoutMs) || 0;
    limitMs = Number.isSafeInteger(budget) && budget > 0 ? budget : 0;
    if (total > 0) {
      freshDeadlineAt = now() + total;
      deadlineAt = Number(attempt.requestDeadlineAt) || freshDeadlineAt;
      deadlineTimer = schedule(() => onTimeout(MODEL_REQUEST_DEADLINE, total), Math.max(1, deadlineAt - now()));
      deadlineTimer?.unref?.();
    }
    const write = res.write;
    if (typeof write === 'function') {
      res.write = function stallWatchProgress(...args) {
        if (args[0] != null && readProgress(args[0])) noteProgress();
        return write.apply(this, args);
      };
    }
    const end = res.end;
    if (typeof end === 'function') {
      res.end = function stallWatchEnd(...args) {
        finish();
        return end.apply(this, args);
      };
    }
    if (typeof res.once === 'function') {
      res.once('finish', finish);
      res.once('close', finish);
      res.once('error', finish);
    }
    rearm();
    return true;
  }

  function isolateRetryBudget() {
    // Claude 路由可能先查主供应商，再解析出子供应商；子请求不能继承主请求的重试余额。
    if (finished || !freshDeadlineAt || deadlineAt === freshDeadlineAt) return;
    if (deadlineTimer !== null) unschedule(deadlineTimer);
    deadlineAt = freshDeadlineAt;
    deadlineTimer = schedule(() => onTimeout(MODEL_REQUEST_DEADLINE), Math.max(1, deadlineAt - now()));
    deadlineTimer?.unref?.();
  }

  function dispose() { finish(); }

  return Object.freeze({
    arm,
    noteProgress,
    isolateRetryBudget,
    dispose,
    isArmed: () => armed,
    timeoutMs: () => limitMs,
    progressed: () => progressed,
    deadlineAt: () => deadlineAt,
    connectTimeout: () => { if (armed && !finished) onTimeout(MODEL_CONNECT_TIMEOUT, connectMs); },
  });
}

module.exports = {
  MODEL_REQUEST_DEADLINE,
  MODEL_CONNECT_TIMEOUT,
  PROXY_STALL_CODES,
  RESPONSE_STALLED_BEFORE_RESPONSE,
  STREAM_IDLE_TIMEOUT,
  createProxyStallWatch,
  isProxyStallCode,
  stallCodeFor,
  terminateStalledResponse,
};
