'use strict';
// 任务「待办」：需要我接手的任务放在一起看。四类来源 ——
//   1. 等待用户输入（runState = waiting）
//   2. 出错（runState = error）
//   3. 执行成功但需要交互（succeeded + goalState = interact）
//   4. 用户手动「标记为待办」的（服务端 air-todos.json，随 /api/air 快照的 taskTodos 下发）
// 前三类是服务端折好的运行态，这里只读不推；第四类是用户的选择，清单住在服务端，
// Web 与 App、换设备都看同一份（src/workspace/todos.js）。App 的同一条判定在
// app/lib/widgets/air/air_task_status.dart 的 airTaskTodo，两边口径必须一致。
//
// 归档的任务不算待办；手动标记的任务即便已经跑完也留着，直到用户自己取消。
// 「手动忽略」是另一层人工状态（air-todo-ignores.json，随 taskTodoIgnored 下发）：
// 被忽略的任务暂时退出待办；任务有新动静后服务端自动让它失效并重新提醒。
(function initAirTaskTodo(root) {
  if (!root || !root.document) return;
  const document = root.document;
  const translate = (key, params) => (typeof root.t === 'function' ? root.t(key, params) : key);
  let ids = new Set();
  let ignored = new Set();
  let hooks = null;

  /** 快照到了就换成服务端那份（304 不会调到这里，手上的那份继续有效）。 */
  function sync(snapshot) {
    ids = new Set(Array.isArray(snapshot?.taskTodos) ? snapshot.taskTodos : []);
    ignored = new Set(Array.isArray(snapshot?.taskTodoIgnored) ? snapshot.taskTodoIgnored : []);
  }

  const isManual = id => !!id && ids.has(id);
  const isIgnored = id => !!id && ignored.has(id);

  function isTodo(task) {
    if (!task || task.status === 'archived') return false;
    if (isIgnored(task.id)) return false;
    if (isManual(task.id)) return true;
    const state = root.MultiCCAirAdmin?.taskStatus?.(task);
    return state === 'waiting' || state === 'error'
      || (state === 'succeeded' && task.goalState === 'interact');
  }

  /** 行内那枚小旗：只标手动标记的（运行态那三类已经有自己的徽标）。 */
  function mark(task) {
    if (!isManual(task?.id)) return null;
    const flag = document.createElement('span');
    flag.className = 'task-todo-mark';
    flag.textContent = '🚩';
    flag.title = translate('airTodoFilter');
    return flag;
  }

  function label(on) { return translate(on ? 'airTodoUnmark' : 'airTodoMark'); }

  function paintButton(button, on) {
    button.setAttribute('aria-pressed', String(on));
    button.title = label(on);
    button.setAttribute('aria-label', label(on));
    const name = button.querySelector('.air-tool-name');
    if (name) name.textContent = label(on);
  }

  async function toggleIgnore(taskId) {
    if (!taskId || !hooks) return;
    const known = (hooks.tasks?.() || []).find(task => task.id === taskId);
    const title = known?.title || taskId;
    const was = isIgnored(taskId);
    try {
      const result = await hooks.api('/api/air/todos/ignore', { taskId });
      ids = new Set(Array.isArray(result.todos) ? result.todos : []);
      ignored = new Set(Array.isArray(result.taskIds) ? result.taskIds : []);
      // 快照刷新会清空 notice：成功文案必须等它回来之后再写。
      await hooks.refresh?.();
      hooks.rerender?.();
      hooks.notice(translate(was ? 'airTodoUnignoredDone' : 'airTodoIgnoredDone', { title }));
    } catch (error) {
      hooks.notice(error.message || String(error));
    }
  }

  async function toggle(taskId) {
    if (!taskId || !hooks) return;
    const known = (hooks.tasks?.() || []).find(task => task.id === taskId);
    const title = known?.title || taskId;
    try {
      const result = await hooks.api('/api/air/todos/toggle', { taskId });
      ids = new Set(Array.isArray(result.taskIds) ? result.taskIds : []);
      hooks.notice(translate(isManual(taskId) ? 'airTodoMarked' : 'airTodoUnmarked', { title }));
      hooks.rerender?.();
    } catch (error) {
      hooks.notice(error.message || String(error));
    }
  }

  /** 列表行尾的开关（目录首页、控制台共用）。点它不打开任务。 */
  function rowButton(task) {
    if (!hooks || !task?.id) return null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'task-todo';
    button.dataset.action = 'todo';
    button.textContent = isManual(task.id) ? '🚩' : '⚑';
    paintButton(button, isManual(task.id));
    button.onclick = event => { event.stopPropagation(); void toggle(task.id); };
    return button;
  }

  /** 「忽略 / 取消忽略」：只在待办行和已忽略行出现（已忽略的取回入口就在过滤器里）。 */
  function ignoreButton(task) {
    if (!hooks || !task?.id || !(isTodo(task) || isIgnored(task.id))) return null;
    const on = isIgnored(task.id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'task-ignore';
    button.dataset.action = 'ignore-todo';
    button.textContent = translate(on ? 'airTodoUnignore' : 'airTodoIgnore');
    button.setAttribute('aria-pressed', String(on));
    button.onclick = event => { event.stopPropagation(); void toggleIgnore(task.id); };
    return button;
  }

  /** 待办开关与忽略开关一起交给行尾：调用方不必知道哪一类该出现哪一颗。 */
  function rowButtons(task) {
    return [rowButton(task), ignoreButton(task)].filter(Boolean);
  }

  /** 页头那两颗：当前打开的任务才出现（和 📌 并排）。 */
  function paintHeader(taskId) {
    const button = document.getElementById('todo-task');
    if (button) { button.hidden = !taskId; paintButton(button, isManual(taskId)); }
    const ignore = document.getElementById('ignore-task');
    if (!ignore) return;
    ignore.hidden = !taskId;
    const on = isIgnored(taskId);
    const text = translate(on ? 'airTodoUnignore' : 'airTodoIgnore');
    ignore.setAttribute('aria-pressed', String(on));
    ignore.title = text;
    ignore.setAttribute('aria-label', text);
    const name = ignore.querySelector('.air-tool-name');
    if (name) name.textContent = text;
  }

  /** air.js 启动时交出它的 api / notice / 当前任务 / 刷新与重绘，模块不自己猜。 */
  function mount(next) {
    hooks = next;
    const button = document.getElementById('todo-task');
    if (button) button.onclick = () => { void toggle(hooks.taskId?.()); };
    const ignore = document.getElementById('ignore-task');
    if (ignore) ignore.onclick = () => { void toggleIgnore(hooks.taskId?.()); };
  }

  root.MultiCCAirTaskTodo = Object.freeze({
    sync, isManual, isIgnored, isTodo, mark, rowButton, ignoreButton, rowButtons, paintHeader, toggle, toggleIgnore, mount,
  });
})(typeof window !== 'undefined' ? window : globalThis);
