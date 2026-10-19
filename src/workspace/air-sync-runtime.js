'use strict';
const { createAirReadIndex } = require('./air-read-index');

// 一个宿主只有一个生产者。事件走逐卡更新；定期分批核对补偿旧写入口和时间态。
// HTTP/WS 消费者均不能自行启动一轮完整构建。
function createAirSyncRuntime({ build, subscribe, taskIdsForSession = () => [], send,
  logger = console, reconcileMs = 30_000, debounceMs = 100, index = createAirReadIndex() }) {
  const clients = new Map();
  let stopped = false, inFlight = null, timer = null, dueAt = Infinity, full = true, dirty = new Set();
  let lastError = null, checkedAt = 0, retryAt = 0;
  function schedule(ms = debounceMs) {
    const delay = Math.max(ms, retryAt - Date.now());
    if (stopped || (timer && dueAt <= Date.now() + delay)) return;
    clearTimeout(timer); dueAt = Date.now() + delay;
    timer = setTimeout(() => { timer = null; dueAt = Infinity; void flush(); }, delay); timer.unref?.();
  }
  function invalidate(ids) {
    if (stopped) return;
    if (!ids || !ids.length) full = true;
    else for (const id of ids) dirty.add(id);
    schedule();
  }
  function publish(event) {
    if (!event) return;
    for (const [socket, dayStart] of clients) {
      if (socket.readyState !== 1) continue;
      try { send(socket, { ...event, taskStats: index.stats(dayStart) }); } catch (_) { socket.close?.(); }
    }
  }
  function flush() {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimeout(timer); timer = null; dueAt = Infinity;
    const all = full || !dirty.size || !index.isReady(), ids = [...dirty];
    full = false; dirty.clear();
    inFlight = (async () => {
      try {
        const snapshot = await build(all ? null : ids);
        if (stopped) return;
        const present = new Set(snapshot.tasks.map(task => task.id));
        const event = index.apply(snapshot, { partial: !all, removed: all ? [] : ids.filter(id => !present.has(id)) });
        checkedAt = Date.now(); lastError = null; retryAt = 0; publish(event);
      } catch (error) {
        full = true; lastError = error; retryAt = Date.now() + 5000;
        logger.warn?.('air_sync_refresh_failed', { code: error?.code || 'refresh_failed' });
      } finally {
        inFlight = null;
        // 失败后有界退避；持续事件不会造成无间隔重算。
        schedule(lastError ? 5000 : (full || dirty.size ? debounceMs : reconcileMs));
      }
    })();
    return inFlight;
  }
  async function ensureReady() {
    if (!index.isReady()) await (inFlight || flush());
    if (!index.isReady()) throw Object.assign(new Error('首页摘要正在准备，请稍后重试'), { status: 503, code: 'air_warming' });
  }
  const unsubscribe = subscribe?.((dirId, event) => {
    // token/tool/heartbeat 不是首页摘要输入，不能把每个流式事件变成后台全表刷新。
    if (['task_board_update', 'task_state', 'status', 'summary', 'session_queue_status', 'session_configuration_applied',
      'session_created', 'session_deleted', 'session_renamed', 'merge_state', 'workspace_state'].includes(event?.type)) {
      const ids = event.taskIds || (event.sessionId ? taskIdsForSession(event.sessionId) : null);
      invalidate(ids);
    }
  });
  function attach(socket, url) {
    socket.once('close', () => clients.delete(socket));
    void ensureReady().then(() => {
      if (stopped || socket.readyState !== 1) return;
      // 同步读取重放窗口后再订阅；这一段不 await，不会插入 live 事件。
      clients.set(socket, Number(url.searchParams.get('dayStart')) || 0);
      const response = index.changes(url.searchParams.get('cursor'));
      if (response.reset) send(socket, { type: 'air_reset', cursor: index.cursor() });
      else {
        for (const event of response.events) send(socket, { ...event, taskStats: index.stats(clients.get(socket)) });
        send(socket, { type: 'air_synced', cursor: index.cursor(), checkedAt, degraded: !!lastError });
      }
    }).catch(() => { try { socket.close(1013, '首页摘要正在准备'); } catch (_) {} });
  }
  function mount(app, route) {
    app.get('/api/air/sync', route(async req => {
      await ensureReady();
      const q = req.query || {};
      if (q.cursor) return { ...index.changes(q.cursor), taskStats: index.stats(Number(q.dayStart) || 0), checkedAt, degraded: !!lastError };
      return { ...index.bootstrap({ include: String(q.include || '').split(',').filter(Boolean), dayStart: Number(q.dayStart) || 0 }),
        checkedAt, degraded: !!lastError };
    }));
    app.get('/api/air/page', route(async req => {
      await ensureReady();
      const q = req.query || {};
      let visits = {};
      try { visits = JSON.parse(String(q.visits || '{}').slice(0, 10_000)); } catch (_) {}
      return index.page({ ...q, visits, ids: q.ids === undefined ? null : String(q.ids).split(',').filter(Boolean) });
    }));
  }
  schedule(0);
  return { index, ensureReady, invalidate, attach, mount, flush,
    close() { stopped = true; clearTimeout(timer); unsubscribe?.(); for (const socket of clients.keys()) socket.close?.(1001, '服务关闭'); clients.clear(); return inFlight || Promise.resolve(); } };
}
module.exports = { createAirSyncRuntime };
