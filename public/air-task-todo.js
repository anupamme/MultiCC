'use strict';
// 任务「等我处理」：系统汇总口径，四类来源 ——
//   1. 等待用户输入（runState = waiting）
//   2. 出错（runState = error）
//   3. 执行成功但需要交互（succeeded + goalState = interact）
//   4. 用户手动「标记为待办」的（服务端 air-todos.json，随 /api/air 快照的 taskTodos 下发）
// 前三类是服务端折好的运行态，这里只读不推；第四类是用户的选择，清单住在服务端，
// Web 与 App、换设备都看同一份（src/workspace/todos.js）。App 的同一条判定在
// app/lib/widgets/air/air_task_status.dart 的 airTaskTodo，两边口径必须一致。
//
// 「待办」是另一件事：只列用户手动标记的（isManualTodo），不含系统判出来的三类。
// 归档的任务两边都不算；手动标记的任务即便已经跑完也留着，直到用户自己取消。
// 「手动忽略」是另一层人工状态（air-todo-ignores.json，随 taskTodoIgnored 下发）：
// 被忽略的任务暂时退出「等我处理」，但不会是「待办」的判据。任务有新动静后服务端
// 自动让它失效并重新提醒。忽略与手动待办在服务端互不排斥，各自独立。
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
  /** 手动待办：归档了就不算；被忽略与否不影响它 —— 忽略只管「等我处理」。 */
  const isManualTodo = task => !!task && task.status !== 'archived' && isManual(task.id);
  const stateOf = task => root.MultiCCAirAdmin?.taskStatus?.(task);

  /** 系统汇总口径：等回答 / 出错 / 需要交互 / 手动标记，排除归档与被忽略的。 */
  function needsMe(task) {
    if (!task || task.status === 'archived') return false;
    if (isIgnored(task.id)) return false;
    if (isManual(task.id)) return true;
    const state = stateOf(task);
    return state === 'waiting' || state === 'error'
      || (state === 'succeeded' && task.goalState === 'interact');
  }
  // 旧名字保留为别名：其他地方（侧栏徽标、目录统计卡）仍读 isTodo。
  const isTodo = needsMe;

  /** 行内小旗：手动待办 🚩；被忽略的再加一枚「已忽略」小标。 */
  function mark(task) {
    const flags = [];
    if (isManual(task?.id)) {
      const flag = document.createElement('span');
      flag.className = 'task-todo-mark';
      flag.textContent = '🚩';
      flag.title = translate('airTodoFilter');
      flags.push(flag);
    }
    if (isIgnored(task?.id)) {
      const badge = document.createElement('span');
      badge.className = 'task-ignored-badge';
      badge.textContent = translate('airTodoIgnoredBadge');
      flags.push(badge);
    }
    if (!flags.length) return null;
    const wrap = document.createElement('span');
    wrap.className = 'task-todo-flags';
    wrap.append(...flags);
    return wrap;
  }

  /**
   * 同一位置上永远只有一颗按钮，随状态换名字与动作。优先级：
   * 已忽略（取消忽略）> 手动待办（取消待办）> 随状态的动作 > 标记待办。
   */
  function action(task) {
    const id = task?.id;
    if (isIgnored(id)) return { key: 'airTodoUnignore', icon: '🚫', pressed: true, kind: 'unignore', run: () => toggleIgnore(id) };
    if (isManual(id)) return { key: 'airTodoUnmark', icon: '🚩', pressed: true, kind: 'unmark', run: () => toggle(id) };
    const state = stateOf(task);
    if (state === 'error') return { key: 'airTodoIgnoreError', icon: '🚫', pressed: false, kind: 'ignore-error', run: () => toggleIgnore(id) };
    if (state === 'waiting') return { key: 'airTodoIgnoreWaiting', icon: '🚫', pressed: false, kind: 'ignore-waiting', run: () => toggleIgnore(id) };
    if (state === 'succeeded' && task?.goalState === 'interact') {
      return { key: 'airTodoMarkAchieved', icon: '✅', pressed: false, kind: 'mark-achieved', run: () => markAchieved(id) };
    }
    return { key: 'airTodoMark', icon: '🚩', pressed: false, kind: 'mark', run: () => toggle(id) };
  }

  function fail(error) {
    const key = error?.code === 'todo_ignore_not_applicable' || error?.code === 'mark_achieved_not_applicable'
      ? 'airTodoErrNotApplicable' : '';
    hooks?.notice(key ? translate(key) : error.message || String(error));
  }

  function taskTitle(taskId) {
    return (hooks?.tasks?.() || []).find(task => task.id === taskId)?.title || taskId;
  }

  async function toggleIgnore(taskId) {
    if (!taskId || !hooks) return;
    const title = taskTitle(taskId);
    const was = isIgnored(taskId);
    try {
      const result = await hooks.api('/api/air/todos/ignore', { taskId });
      ids = new Set(Array.isArray(result.todos) ? result.todos : [...ids]);
      ignored = new Set(Array.isArray(result.taskIds) ? result.taskIds
        : (typeof result.ignored === 'boolean' ? (result.ignored ? [...ignored, taskId] : [...ignored].filter(id => id !== taskId)) : [...ignored]));
      // 快照刷新会清空 notice：成功文案必须等它回来之后再写。
      await hooks.refresh?.();
      hooks.rerender?.();
      const nowIgnored = typeof result.ignored === 'boolean' ? result.ignored : !was;
      hooks.notice(translate(nowIgnored ? 'airTodoIgnoredDone' : 'airTodoUnignoredDone', { title }));
    } catch (error) {
      fail(error);
    }
  }

  async function toggle(taskId) {
    if (!taskId || !hooks) return;
    const title = taskTitle(taskId);
    try {
      const result = await hooks.api('/api/air/todos/toggle', { taskId });
      ids = new Set(Array.isArray(result.taskIds) ? result.taskIds : []);
      hooks.rerender?.();
      hooks.notice(translate(isManual(taskId) ? 'airTodoMarked' : 'airTodoUnmarked', { title }));
    } catch (error) {
      fail(error);
    }
  }

  async function markAchieved(taskId) {
    if (!taskId || !hooks) return;
    const title = taskTitle(taskId);
    try {
      await hooks.api('/api/air/tasks/mark-achieved', { taskId });
      // 成功文案写在刷新之后：refresh 会把 notice 清空。
      await hooks.refresh?.();
      hooks.rerender?.();
      hooks.notice(translate('airTodoMarkAchievedDone', { title }));
    } catch (error) {
      fail(error);
    }
  }

  /** 列表行尾那一颗（目录首页、控制台共用）。点它不打开任务。 */
  function rowButton(task, className = 'task-todo') {
    if (!hooks || !task?.id) return null;
    const spec = action(task);
    const text = translate(spec.key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.action = spec.kind;
    button.textContent = text;
    button.title = text;
    button.setAttribute('aria-label', text);
    button.setAttribute('aria-pressed', String(spec.pressed));
    button.onclick = event => { event.stopPropagation(); void spec.run(); };
    return button;
  }

  /** 调用方不必知道哪一类该出现哪一颗：同一位置只会有一颗。 */
  function rowButtons(task, className) {
    return [rowButton(task, className)].filter(Boolean);
  }

  /** 任务详情页头那颗（和 📌 并排）：只在当前打开的任务上出现。 */
  function paintHeader(taskId) {
    const button = document.getElementById('todo-task');
    if (!button) return;
    button.hidden = !taskId;
    if (!taskId) return;
    const task = (hooks?.tasks?.() || []).find(item => item.id === taskId);
    const spec = action(task || { id: taskId });
    const text = translate(spec.key);
    button.dataset.action = spec.kind;
    button.setAttribute('aria-pressed', String(spec.pressed));
    button.title = text;
    button.setAttribute('aria-label', text);
    const icon = button.querySelector('.air-tool-icon');
    if (icon) icon.textContent = spec.icon;
    const name = button.querySelector('.air-tool-name');
    if (name) name.textContent = text;
  }

  /** air.js 启动时交出它的 api / notice / 当前任务 / 刷新与重绘，模块不自己猜。 */
  function mount(next) {
    hooks = next;
    const button = document.getElementById('todo-task');
    if (button) {
      button.onclick = event => {
        event.preventDefault();
        const id = hooks.taskId?.();
        if (!id) return;
        void action((hooks.tasks?.() || []).find(task => task.id === id) || { id }).run();
      };
    }
  }

  root.MultiCCAirTaskTodo = Object.freeze({
    sync, isManual, isIgnored, isManualTodo, needsMe, isTodo, mark, action,
    rowButton, rowButtons, paintHeader, toggle, toggleIgnore, markAchieved, mount,
  });
})(typeof window !== 'undefined' ? window : globalThis);
