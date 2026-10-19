'use strict';

// 「手动忽略」是待办视图上的人工状态：用户已知晓、不想再被提醒（尤其是出错）
// 的任务。这些用例钉住：忽略/取消与落盘往返、与手动待办互斥、有新动静自动失效、
// 任务删除剪枝、错误码、以及 /api/air 快照确实带着 taskTodoIgnored。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { airResponse } = require('./helpers/air-response');

const { TODO_IGNORE_LIMIT, createAirTodoIgnoreRuntime } = require('../src/workspace/todo-ignores');
const { createAirTodoRuntime } = require('../src/workspace/todos');
const { mountAirRoutes } = require('../src/workspace/air-routes');

function tempFile(name = 'air-todo-ignores.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-air-todo-ignores-')), name);
}

function call(handler, { params = {}, body = {} } = {}) {
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(value) { response.body = value; return this; },
  };
  handler({ params, body }, res);
  return response;
}

function mountFixture(tasks, pinsFile) {
  const board = { tasks: Object.fromEntries(tasks.map(task => [task.id, { title: task.id, ...task }])) };
  const handlers = new Map();
  const app = { get: (route, fn) => handlers.set(`GET ${route}`, fn), post: (route, fn) => handlers.set(`POST ${route}`, fn) };
  mountAirRoutes(app, {
    pinsFile, getBoard: () => board,
    admission: { snapshot: () => ({ workspaces: [], leases: [], budgets: {} }) },
    records: new Map(), directories: new Map(), clis: ['claude'],
    shell: { taskAccess: () => ({ readOnly: false }) },
  });
  return { handlers, board };
}

test('忽略再取消，stamp 取自任务 updatedAt 且忽略动作不动任务；落盘往返仍在', () => {
  const file = tempFile();
  const tasks = [{ id: 't1', updatedAt: 1000 }];
  const runtime = createAirTodoIgnoreRuntime({ file, listTasks: () => tasks, readTodos: () => [] });

  assert.deepEqual(runtime.read(), []);
  const ignored = runtime.toggle('t1');
  assert.deepEqual(ignored, { ignored: true, taskIds: ['t1'], todos: [] });
  // 忽略动作本身绝不能把任务的 updatedAt 推大，否则刚写下的 stamp 立刻作废。
  assert.equal(tasks[0].updatedAt, 1000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).data.items, [{ taskId: 't1', stamp: 1000 }]);

  // 换一个运行时实例（进程重启）仍读得到。
  const reopened = createAirTodoIgnoreRuntime({ file, listTasks: () => tasks, readTodos: () => [] });
  assert.deepEqual(reopened.read(), ['t1']);

  assert.deepEqual(reopened.toggle('t1'), { ignored: false, taskIds: [], todos: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).data.items, []);
  assert.ok(TODO_IGNORE_LIMIT >= 100);
});

test('任务之后又有新动静（updatedAt > stamp）时忽略自动失效；再点一次记新 stamp', () => {
  const file = tempFile();
  const tasks = [{ id: 't1', updatedAt: 1000 }];
  const runtime = createAirTodoIgnoreRuntime({ file, listTasks: () => tasks, readTodos: () => [] });
  runtime.toggle('t1');
  assert.deepEqual(runtime.read(), ['t1']);

  tasks[0].updatedAt = 1001;   // 又出错了 / 又在等了
  assert.deepEqual(runtime.read(), [], '读取时应剪掉失效的忽略');
  // 失效项只是读时过滤，写盘时才真正清理：再忽略要记下新的时刻。
  const again = runtime.toggle('t1');
  assert.equal(again.ignored, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).data.items, [{ taskId: 't1', stamp: 1001 }]);
  assert.deepEqual(runtime.read(), ['t1']);
});

test('任务被删后忽略掉下来；未知任务 404、空 taskId 400、落盘失败用自己的错误码', () => {
  const tasks = [{ id: 't1', updatedAt: 1000 }, { id: 't2', updatedAt: 2000 }];
  const runtime = createAirTodoIgnoreRuntime({ file: tempFile(), listTasks: () => tasks, readTodos: () => [] });
  runtime.toggle('t1');
  runtime.toggle('t2');
  tasks.splice(0, 1);
  assert.deepEqual(runtime.read(), ['t2']);
  assert.throws(() => runtime.toggle('t1'), { status: 404, code: 'task_not_found' });
  assert.throws(() => runtime.toggle('  '), { status: 400, code: 'task_id_required' });

  const blocker = tempFile('blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const blocked = createAirTodoIgnoreRuntime({
    file: path.join(blocker, 'ignores.json'), listTasks: () => tasks, logger: { warn() {} },
  });
  assert.throws(() => blocked.toggle('t2'), { code: 'todo_ignore_save_failed' });
});

test('忽略与手动待办互斥（HTTP 接线）：忽略时移出待办，标记待办时清掉忽略', () => {
  const pinsFile = tempFile('air-pins.json');
  const tasks = [{ id: 't1', updatedAt: 1000 }, { id: 't2', updatedAt: 2000 }];
  const { handlers } = mountFixture(tasks, pinsFile);
  const ignore = body => call(handlers.get('POST /api/air/todos/ignore'), { body });
  const todoToggle = body => call(handlers.get('POST /api/air/todos/toggle'), { body });

  assert.deepEqual(todoToggle({ taskId: 't1' }).body.taskIds, ['t1']);
  assert.deepEqual(ignore({ taskId: 't2' }).body, { ok: true, ignored: true, taskIds: ['t2'], todos: ['t1'] });
  // 忽略一个在手动待办里的任务 → 同时从待办移除。
  assert.deepEqual(ignore({ taskId: 't1' }).body, { ok: true, ignored: true, taskIds: ['t2', 't1'], todos: [] });
  assert.deepEqual(call(handlers.get('GET /api/air/todos')).body.taskIds, []);
  // 再点一次 → 取消忽略。
  assert.deepEqual(ignore({ taskId: 't1' }).body, { ok: true, ignored: false, taskIds: ['t2'], todos: [] });
  // 反过来：标记为待办时自动清掉它的忽略。
  assert.deepEqual(todoToggle({ taskId: 't2' }).body.taskIds, ['t2']);
  const res = airResponse();
  return handlers.get('GET /api/air')({}, res).then(() => {
    const snapshot = JSON.parse(res.body);
    assert.deepEqual(snapshot.taskTodos, ['t2']);
    assert.deepEqual(snapshot.taskTodoIgnored, []);
    // 未知任务 404、缺 taskId 400，错误码与 todos 同一风格。
    const missing = ignore({ taskId: 'ghost' });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.code, 'task_not_found');
    assert.equal(ignore({}).statusCode, 400);
  });
});

test('/api/air 快照带 taskTodoIgnored（只含有效项），失效/已删项被剪掉', async () => {
  const pinsFile = tempFile('air-pins.json');
  const tasks = [{ id: 't1', updatedAt: 1000 }, { id: 't2', updatedAt: 2000 }];
  const { handlers, board } = mountFixture(tasks, pinsFile);
  const ignore = taskId => call(handlers.get('POST /api/air/todos/ignore'), { body: { taskId } });
  ignore('t1');
  ignore('t2');
  // 忽略文件落在 pins 文件旁边（测试不碰真实数据目录）。
  assert.ok(fs.existsSync(path.join(path.dirname(pinsFile), 'air-todo-ignores.json')));

  let res = airResponse();
  await handlers.get('GET /api/air')({}, res);
  assert.deepEqual(JSON.parse(res.body).taskTodoIgnored, ['t1', 't2']);

  // t1 有了新动静、t2 被删：快照里两个都不该再出现。
  board.tasks.t1.updatedAt = 1001;
  delete board.tasks.t2;
  res = airResponse();
  await handlers.get('GET /api/air')({}, res);
  assert.deepEqual(JSON.parse(res.body).taskTodoIgnored, []);
});
