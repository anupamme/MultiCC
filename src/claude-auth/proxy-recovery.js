'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { Writable } = require('node:stream');

const MAX_REQUEST_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const ERROR_TIMEOUT_MS = 5000;

// CPR 的正文修复钩子不会重建认证头。宿主在它外面暂存首次认证拒绝，
// 更新凭据后重新经过原处理器；成功流不缓存，回合和工具都不会重放。
function createClaudeOAuthProxyRecovery(app, options = {}) {
  if (typeof options.recoverOfficialCredential !== 'function'
      || typeof options.readOfficialCredential !== 'function') return { app, options };
  const contexts = new AsyncLocalStorage();

  function callback(name, event) {
    const state = contexts.getStore();
    if (state?.holding && (name === 'onUsageEvent' || event.phase !== 'request')) {
      state.deferred.push([name, event]);
      return;
    }
    if (name === 'onActivity' && event.phase === 'request' && state) {
      if (state.logical.started) return;
      state.logical.started = true;
    }
    return options[name]?.(event);
  }

  function flushEvents(state, disconnected = false) {
    for (const [name, event] of state.deferred.splice(0)) {
      const terminal = disconnected && name === 'onUsageEvent'
        ? { ...event, status: 'error', statusCode: undefined, errorCode: 'DOWNSTREAM_DISCONNECT' } : event;
      try { options[name]?.(terminal); } catch (_) { /* 观测回调不影响响应。 */ }
    }
  }

  function responseFor(res, state, mayRecover) {
    let head = null, chunks = [], bytes = 0, timer;
    let resolve;
    const done = new Promise(r => { resolve = r; });
    function flush() {
      if (!state.holding) return;
      state.holding = false;
      clearTimeout(timer);
      res.writeHead(...head);
      for (const chunk of chunks) res.write(chunk);
      chunks = [];
      flushEvents(state);
    }
    const sink = new Writable({
      autoDestroy: false,
      write(chunk, encoding, cb) {
        if (state.holding) {
          bytes += chunk.length;
          if (bytes <= MAX_ERROR_BYTES) { chunks.push(Buffer.from(chunk)); cb(); return; }
          flush(); // 超大错误保持原样转发，不缓存也不重试。
        }
        if (res.destroyed) { cb(); return; }
        res.write(chunk, encoding, cb);
      },
      final(cb) {
        if (state.holding || res.destroyed) cb();
        else res.end(cb);
      },
    });
    sink.statusCode = 200;
    Object.defineProperty(sink, 'headersSent', { get: () => res.headersSent });
    sink.writeHead = (...args) => {
      sink.statusCode = Number(args[0]);
      state.holding = mayRecover && !!state.credential
        && (sink.statusCode === 401 || sink.statusCode === 403) && !res.headersSent;
      if (state.holding) {
        head = args;
        timer = setTimeout(() => sink.destroy(), options.authErrorTimeoutMs || ERROR_TIMEOUT_MS);
        timer.unref?.();
      } else res.writeHead(...args);
      return sink;
    };
    // CPR 使用 close 回收上游连接；真实客户端取消也必须传进暂存响应。
    const close = () => contexts.run(state, () => {
      sink.destroy();
      if (state.holding) {
        state.holding = false;
        clearTimeout(timer);
        chunks = [];
        flushEvents(state, true);
      }
    });
    res.once('close', close);
    sink.on('error', () => {});
    sink.once('finish', () => { clearTimeout(timer); resolve(true); });
    sink.once('close', () => resolve(false));
    return {
      sink, done,
      body: () => Buffer.concat(chunks).toString('utf8'),
      flush,
      dispose() { clearTimeout(timer); res.removeListener('close', close); contexts.run(state, () => sink.destroy()); },
    };
  }

  async function invoke(handler, req, res, next) {
    const logical = { started: false };
    let chunks = [], bytes = 0, replayable = true;
    // 只旁听原处理器实际读取的字节，不提前消费流，也不重写提示词。
    function requestFor(retry) {
      return new Proxy(req, {
        get(target, key) {
          if (key === Symbol.asyncIterator) return async function* () {
            if (retry) { yield* chunks; return; }
            for await (const chunk of target) {
              bytes += chunk.length;
              if (replayable && bytes <= MAX_REQUEST_BYTES) chunks.push(Buffer.from(chunk));
              else { replayable = false; chunks = []; }
              yield chunk;
            }
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = { logical, holding: false, deferred: [], credential: null };
      const response = responseFor(res, state, attempt === 0);
      try {
        await contexts.run(state, () => handler(requestFor(attempt > 0), response.sink, next));
        const complete = await response.done;
        if (!state.holding) return;
        const status = response.sink.statusCode;
        const authenticationError = status === 401
          || status === 403 && /OAuth (?:access )?token (?:has been |was )?revoked/i.test(response.body());
        if (complete && replayable && authenticationError && !res.destroyed && !res.headersSent) {
          let recovered;
          try {
            recovered = await options.recoverOfficialCredential(state.credential.arg, state.credential.token);
          } catch (_) { /* 恢复失败时保留原始认证错误。 */ }
          if (recovered?.token && recovered.token !== state.credential.token && !res.destroyed && !res.headersSent) {
            state.deferred = []; // 首次拒绝不应提前结束逻辑请求或污染最终错误归因。
            continue;
          }
        }
        if (!res.destroyed) {
          response.flush();
          // 未完整收到的错误不能当作完整响应结束（可能带原始 Content-Length）。
          if (complete) res.end();
          else res.destroy();
        }
        return;
      } finally { response.dispose(); }
    }
  }

  return {
    app: {
      use(pathname, handler) {
        return app.use(pathname, (req, res, next) => invoke(handler, req, res, next));
      },
    },
    options: {
      ...options,
      async readOfficialCredential(arg) {
        const result = await options.readOfficialCredential(arg);
        const state = contexts.getStore();
        if (state && arg && typeof arg === 'object' && arg.accountId && result?.token) {
          state.credential = { arg, token: result.token };
        }
        return result;
      },
      ...(typeof options.onActivity === 'function' ? { onActivity: event => callback('onActivity', event) } : {}),
      ...(typeof options.onUsageEvent === 'function' ? { onUsageEvent: event => callback('onUsageEvent', event) } : {}),
    },
  };
}

module.exports = { createClaudeOAuthProxyRecovery };
