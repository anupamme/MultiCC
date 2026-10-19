'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { channel } = require('node:diagnostics_channel');

// Node HTTP 与 Undici 的公共诊断事件用于连接计时；不替换全局网络方法。
// 只有准入模型请求的异步作用域会启动计时器，连接完成后不计首 token 等待。
const scope = new AsyncLocalStorage();
const pending = new WeakMap();

function begin(request) {
  const context = scope.getStore();
  const ms = Number(context?.attempt?.connectTimeoutMs);
  if (!request || !context?.stall?.isArmed() || !(ms > 0)) return;
  end(request);
  const done = () => end(request);
  const timer = setTimeout(() => {
    done();
    context.stall.connectTimeout();
  }, ms);
  timer.unref?.();
  context.response.once('close', done);
  context.response.once('finish', done);
  pending.set(request, () => {
    clearTimeout(timer);
    context.response.removeListener('close', done);
    context.response.removeListener('finish', done);
  });
}

function end(request) {
  pending.get(request)?.();
  pending.delete(request);
}

channel('undici:request:create').subscribe(({ request }) => begin(request));
channel('undici:client:sendHeaders').subscribe(({ request }) => end(request));
channel('undici:request:error').subscribe(({ request }) => end(request));
channel('http.client.request.start').subscribe(({ request }) => {
  if (!scope.getStore()?.stall?.isArmed()) return;
  const watchSocket = socket => {
    if (!socket.connecting) return; // 已建立的复用连接不再等待连接事件。
    begin(request);
    const done = () => {
      end(request);
      socket.removeListener('connect', done);
      socket.removeListener('secureConnect', done);
      socket.removeListener('error', done);
      socket.removeListener('close', done);
    };
    socket.once(socket.encrypted ? 'secureConnect' : 'connect', done);
    socket.once('error', done);
    socket.once('close', done);
  };
  if (request.socket) watchSocket(request.socket);
  else request.once('socket', watchSocket);
  request.once('error', () => end(request));
  request.once('close', () => end(request));
});

function withModelConnectWatch(context, fn) {
  return scope.run(context, fn);
}

module.exports = { withModelConnectWatch };
