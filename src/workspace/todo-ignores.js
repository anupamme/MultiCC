'use strict';

// Air 任务「手动忽略」—— 用户已经知晓、不想再被待办提醒的那些任务。
//
// 待办视图（需要交互 / 等待回复 / 出错 / 手动待办）里总有一类是「我看过了，它在
// 那儿等我处理，但我不想现在处理」。运行态表达不了这件事（它仍然是 error /
// waiting），所以要像 pin、手动待办一样单独落一份用户选择：
//
//   文件：<data dir>/air-todo-ignores.json（默认），形状
//         { items: [{ taskId, stamp }, …] }，stamp = 忽略那一刻任务的 updatedAt。
//   接口：POST /api/air/todos/ignore { taskId } → 切换忽略
//         → { ok, ignored, taskIds, todos }
//
// 忽略只在「任务没有新动静」时有效：读取时若 task.updatedAt > stamp（又出错了、
// 又在等回复了），忽略自己失效，任务重新出现在待办里。任务被删同样掉下来。
// 忽略动作本身只写这份文件，绝不碰任务记录的 updatedAt —— 否则一次点击会把
// 刚写下的 stamp 立刻作废。
//
// 与「手动待办」（./todos.js）互斥：忽略一个任务时把它从手动待办移除；反过来
// 标记为待办时由 air-routes 的 onAdded 钩子清掉它的忽略。

const stateStore = require('../state/store');
const { createPaths } = require('../paths');

const TODO_IGNORE_LIMIT = 500;
const SCHEMA_VERSION = 1;
const FILE_KIND = 'air-todo-ignores';

/** 只做形状归一：丢掉空值、按 taskId 去重、截断上限。有效性由运行时按当下任务表判。 */
function normalizeIgnores(value, limit = TODO_IGNORE_LIMIT) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const taskId = raw && typeof raw.taskId === 'string' ? raw.taskId.trim() : '';
    if (!taskId || seen.has(taskId)) continue;
    const stamp = Number(raw.stamp);
    out.push({ taskId, stamp: Number.isFinite(stamp) ? stamp : 0 });
    seen.add(taskId);
    if (out.length >= limit) break;
  }
  return out;
}

function createAirTodoIgnoreRuntime(rawDeps) {
  const deps = rawDeps || {};
  // 默认跟着 src/paths.js 的数据目录走；宿主（或测试）可以自己指一个文件。
  const file = deps.file || createPaths().airTodoIgnoresFile;
  if (typeof deps.listTasks !== 'function') {
    throw new TypeError(`[${FILE_KIND}] listTasks() is required`);
  }
  const logger = deps.logger || console;
  const store = stateStore.createStore({
    file, kind: FILE_KIND, schemaVersion: SCHEMA_VERSION, legacyIsArray: false,
  });

  // 进程内的权威副本，懒加载：没碰过忽略的实例不该为每次请求付一次 stat。
  let items = null;

  function load() {
    if (items) return items;
    try {
      const r = store.loadOrRecover();
      items = normalizeIgnores(r.present ? r.data?.items : null);
    } catch (e) {
      // 读不出来最多丢掉几个忽略，别的都不影响 —— 从空开始是对的爆炸半径。
      logger.warn(`[multicc/${FILE_KIND}] unreadable file, starting empty: ${e.message}`);
      items = [];
    }
    return items;
  }

  function persist(next) {
    try { store.save({ items: next }); }
    catch (e) {
      logger.warn(`[multicc/${FILE_KIND}] save failed: ${e.message}`);
      throw Object.assign(new Error('忽略状态无法保存'), { code: 'todo_ignore_save_failed', status: 500 });
    }
  }

  // 任务表快照：taskId → updatedAt（毫秒）。读不到返回 null —— 那时不剪枝，
  // 宁可多留一个忽略，也别因为一次「没读到」把用户的选择删掉。
  function taskStamps() {
    try {
      const map = new Map();
      for (const task of deps.listTasks() || []) {
        if (!task || !task.id) continue;
        const raw = task.updatedAt;
        const value = typeof raw === 'number' ? raw : Number(raw);
        map.set(task.id, Number.isFinite(value) && value > 0 ? value : 0);
      }
      return map;
    } catch (_) { return null; }
  }

  function stillValid(entry, stamps) {
    if (!stamps) return true;
    if (!stamps.has(entry.taskId)) return false;      // 任务被删
    return !(stamps.get(entry.taskId) > entry.stamp); // 之后有新动静 → 失效
  }

  /** 当前有效的忽略（读取时剪枝，不写盘：GET 不该有副作用）。 */
  function effective(stamps = taskStamps()) {
    return load().filter(entry => stillValid(entry, stamps));
  }

  function read() { return effective().map(entry => entry.taskId); }

  /** 忽略时刻：任务的 updatedAt；取不到就记当下，别留一个 0 让忽略立刻失效。 */
  function stampOf(stamps, taskId) {
    const value = stamps ? stamps.get(taskId) : 0;
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  /** 一个按钮点下去：忽略着就取消，没忽略就记下。 */
  function toggle(taskId) {
    const id = typeof taskId === 'string' ? taskId.trim() : '';
    if (!id) throw Object.assign(new Error('taskId is required'), { status: 400, code: 'task_id_required' });
    const stamps = taskStamps();
    if (stamps && !stamps.has(id)) {
      throw Object.assign(new Error('任务不存在'), { status: 404, code: 'task_not_found' });
    }
    const current = effective(stamps);
    const wasIgnored = current.some(entry => entry.taskId === id);
    let next;
    if (wasIgnored) {
      next = current.filter(entry => entry.taskId !== id);
    } else {
      if (current.length >= TODO_IGNORE_LIMIT) {
        throw Object.assign(new Error(`最多只能忽略 ${TODO_IGNORE_LIMIT} 个任务`), { status: 409, code: 'todo_ignore_limit_reached' });
      }
      // 顺手把已经失效的老条目剪掉（读取时只过滤，写盘时真正清理）。
      next = [...current, { taskId: id, stamp: stampOf(stamps, id) }];
    }
    persist(next);
    items = next;
    // 与手动待办互斥：忽略后就不该还挂在手动清单里。钩子失败只影响另一份文件
    // 的清理，不该把一次已经成功的忽略变成 500。
    if (!wasIgnored && typeof deps.onIgnored === 'function') {
      try { deps.onIgnored(id); }
      catch (e) { logger.warn(`[multicc/${FILE_KIND}] onIgnored hook failed for ${id}: ${e.message}`); }
    }
    return { ignored: !wasIgnored, taskIds: read(), todos: readTodos() };
  }

  /** 取消某个任务的忽略（标记为待办时调用）；本来就有效忽略才写盘。 */
  function clear(taskId) {
    const id = typeof taskId === 'string' ? taskId.trim() : '';
    if (!id) return false;
    const current = effective();
    if (!current.some(entry => entry.taskId === id)) return false;
    const next = current.filter(entry => entry.taskId !== id);
    persist(next);
    items = next;
    return true;
  }

  function readTodos() {
    if (typeof deps.readTodos !== 'function') return [];
    try { return deps.readTodos(); }
    catch (_) { return []; }
  }

  // `target` 是 express Router（生产）或 app（测试）—— 两者都暴露 post。
  function mountRoutes(target) {
    target.post('/api/air/todos/ignore', (req, res) => {
      try { res.json({ ok: true, ...toggle((req.body || {}).taskId) }); }
      catch (error) {
        res.status(error.status || 500).json({
          ok: false, code: error.code || 'todo_ignore_failed',
          message: error.status ? error.message : 'Request failed',
        });
      }
    });
  }

  return { file, limit: TODO_IGNORE_LIMIT, read, toggle, clear, mountRoutes };
}

module.exports = { TODO_IGNORE_LIMIT, normalizeIgnores, createAirTodoIgnoreRuntime };
