'use strict';
// 任务列表的「待办」：等待用户输入、出错、执行成功但需要交互、手动标记为待办的
// 任务放在一起。fixture 把四类各放一条，再放进不该进来的（在跑、达成目标、空闲、
// 归档了的等待），钉住口径；然后在目录行上点 ⚑ 标记一条空闲任务、在页头点 🚩
// 取消，确认两处都写的是 /api/air/todos/toggle，列表随之增减。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

test('the to-do filter gathers waiting, error, needs-interaction and manually marked tasks', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url` };

  const directories = [{ id: 'd1', name: 'Gapasea', path: '/projects/gapasea' }];
  const now = Date.now();
  const task = (id, title, extra) => ({ id, dirId: 'd1', title, status: 'active', updatedAt: now - id.length,
    resource: { residency: 'planned', lease: 'idle' }, ...extra });
  const tasks = [
    task('tsk-run', '正在跑的活', { runState: 'running' }),
    task('tsk-wait', '等人回答的活', { runState: 'waiting' }),
    task('tsk-err', '炸了的活', { runState: 'error' }),
    task('tsk-interact', '跑完要我确认的活', { runState: 'succeeded', goalState: 'interact' }),
    task('tsk-achieved', '达成目标的活', { runState: 'succeeded', goalState: 'achieved' }),
    task('tsk-marked', '手动标的活', { runState: 'idle' }),
    task('tsk-idle', '空闲的活', { runState: 'idle' }),
    task('tsk-archived', '归档了的等待', { status: 'archived', runState: 'waiting' }),
  ];
  let todos = ['tsk-marked'];
  let ignores = [];
  const toggles = [];
  const ignoreCalls = [];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks, sessions: [],
    taskTodos: todos, taskTodoIgnored: ignores });
  routes['/api/air/todos/toggle'] = ({ body }) => {
    const { taskId } = JSON.parse(body || '{}');
    toggles.push(taskId);
    todos = todos.includes(taskId) ? todos.filter(id => id !== taskId) : [...todos, taskId];
    return json({ ok: true, taskIds: todos });
  };
  routes['POST /api/air/todos/ignore'] = ({ body }) => {
    const { taskId } = JSON.parse(body || '{}');
    ignoreCalls.push(taskId);
    const on = !ignores.includes(taskId);
    if (on) { ignores = [...ignores, taskId]; todos = todos.filter(id => id !== taskId); }
    else ignores = ignores.filter(id => id !== taskId);
    return json({ ok: true, ignored: on, taskIds: ignores, todos });
  };
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-todo-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    // 每次整页导航都会换掉 window，错误钩子要跟着重装，离开前先查一遍。
    const watchErrors = () => page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);
    const noErrors = async () => assert.deepEqual(await page.evaluate('window.__errors'), []);
    await page.navigate('/air?dir=d1');
    await watchErrors();
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length > 0`));
    const titles = () => page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')]
      .map(el => el.textContent).sort()`);
    const ordered = () => page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')]
      .map(el => el.textContent)`);
    const pick = value => page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value=${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);

    assert.equal(await page.evaluate(`document.querySelector('#directory-task-status option').value`), 'todo', '待办是状态下拉的第一档');
    await pick('todo');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===4`));
    assert.deepEqual(await titles(), ['手动标的活', '炸了的活', '等人回答的活', '跑完要我确认的活']);
    assert.deepEqual(await ordered(), ['跑完要我确认的活', '手动标的活', '等人回答的活', '炸了的活'],
      '待办默认按最早的消息时间排在前面');
    // 手动标记的那条带着 🚩，其余三条靠自己的徽标说明为什么在这里。
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-task-list .task-todo-mark').length`), 1);
    await page.screenshot('directory-todo-filter.png');

    // 在「全部记录」里点空闲任务那一行的 ⚑：写服务端，切回待办就多出它。
    await pick('all');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===8`));
    await page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row')]
      .find(row => row.querySelector('strong').textContent === '空闲的活').querySelector('.task-todo').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .task-todo[aria-pressed="true"]').length===2`));
    assert.deepEqual(toggles, ['tsk-idle']);
    await pick('todo');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===5`));
    assert.ok((await titles()).includes('空闲的活'));

    // 忽略一条出错的待办：它立刻从待办消失，服务端记下 taskTodoIgnored，提示在刷新之后还在。
    await page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row')]
      .find(row => row.querySelector('strong').textContent === '炸了的活').querySelector('.task-ignore').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===4`));
    assert.deepEqual(ignoreCalls, ['tsk-err']);
    assert.deepEqual(ignores, ['tsk-err']);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('已忽略')`), '忽略提示不被刷新清掉');
    assert.equal((await titles()).includes('炸了的活'), false, '被忽略的不在待办里');

    // 过滤器里的「已忽略」能找回来，并就地取消忽略。
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-status option[value="ignored"]')?.textContent`), '已忽略');
    await pick('ignored');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===1`));
    assert.deepEqual(await ordered(), ['炸了的活']);
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-list .task-ignore').textContent`), '取消忽略');
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-list .task-ignore').getAttribute('aria-pressed')`), 'true');
    await page.evaluate(`document.querySelector('#directory-task-list .task-ignore').click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===0`));
    assert.deepEqual(ignores, []);
    assert.ok(await page.waitFor(`document.getElementById('notice').textContent.includes('已取消忽略')`));
    await pick('todo');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===5`));
    assert.ok((await titles()).includes('炸了的活'), '取消忽略后回到待办');

    // 打开那条任务：页头 🚩 亮着；点它取消，待办里就少了它。
    await noErrors();
    await page.navigate('/air?dir=d1&task=tsk-idle');
    await watchErrors();
    assert.ok(await page.waitFor(`document.getElementById('todo-task') && !document.getElementById('todo-task').hidden`), '打开任务时才有 🚩');
    assert.ok(await page.waitFor(`document.getElementById('todo-task').getAttribute('aria-pressed')==='true'`));
    await page.evaluate(`document.getElementById('todo-task').click()`);
    assert.ok(await page.waitFor(`document.getElementById('todo-task').getAttribute('aria-pressed')==='false'`));
    assert.deepEqual(toggles, ['tsk-idle', 'tsk-idle']);
    assert.deepEqual(todos, ['tsk-marked']);

    // 任务详情页头也有「忽略」：点一下变「取消忽略」，再点回来。
    assert.ok(await page.waitFor(`document.getElementById('ignore-task') && !document.getElementById('ignore-task').hidden`), '打开任务时才有忽略按钮');
    await page.evaluate(`document.getElementById('ignore-task').click()`);
    assert.ok(await page.waitFor(`document.getElementById('ignore-task').getAttribute('aria-pressed')==='true'`));
    assert.equal(await page.evaluate(`document.querySelector('#ignore-task .air-tool-name').textContent`), '取消忽略');
    assert.deepEqual(ignoreCalls, ['tsk-err', 'tsk-err', 'tsk-idle']);
    await page.evaluate(`document.getElementById('ignore-task').click()`);
    assert.ok(await page.waitFor(`document.getElementById('ignore-task').getAttribute('aria-pressed')==='false'`));
    assert.deepEqual(ignores, []);

    // 手机：「待办」紧跟「最近」，不用横滑就点得到，口径与目录页同一份。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await noErrors();
    await page.navigate('/air');
    await watchErrors();
    assert.ok(await page.waitFor(`document.querySelector('.mobile-console-filters [data-filter="todo"]')`));
    assert.equal(await page.evaluate(`(() => { const b=document.querySelector('.mobile-console-filters [data-filter="todo"]').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; })()`), true);
    assert.ok((await page.evaluate(`document.querySelector('.mobile-console-filters [data-filter="todo"]').textContent`)).endsWith(' 4'));
    await page.screenshot('mobile-todo-filter.png');

    await noErrors();
  });
});

// 目录概览的「待办」卡与状态筛选同源（isTodo）；「异常」独立于忽略开关：
// 被手动忽略的出错任务退出待办，但仍留在异常计数与异常清单里（行上仍能取消忽略）。
// 旧的 waiting 档位已删除，遗留值必须回落到同一份 isTodo。
test('the directory to-do card matches isTodo and ignored errors stay in the error list', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url` };

  const directories = [{ id: 'd1', name: 'Gapasea', path: '/projects/gapasea' }];
  const now = Date.now();
  const task = (id, title, extra) => ({ id, dirId: 'd1', title, status: 'active', updatedAt: now - id.length, lastMessageAt: now - id.length,
    resource: { residency: 'planned', lease: 'idle' }, ...extra });
  const tasks = [
    task('tsk-wait', '等人回答的活', { runState: 'waiting' }),
    task('tsk-err', '炸了的活', { runState: 'error' }),
    task('tsk-err-ignored', '忽略掉的出错', { runState: 'error' }),
    task('tsk-idle', '空闲的活', { runState: 'idle' }),
    task('tsk-archived', '归档了的等待', { status: 'archived', runState: 'waiting' }),
  ];
  let ignores = ['tsk-err-ignored'];
  const ignoreCalls = [];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks, sessions: [],
    taskTodos: [], taskTodoIgnored: ignores });
  routes['POST /api/air/todos/ignore'] = ({ body }) => {
    const { taskId } = JSON.parse(body || '{}');
    ignoreCalls.push(taskId);
    const on = !ignores.includes(taskId);
    ignores = on ? [...ignores, taskId] : ignores.filter(id => id !== taskId);
    return json({ ok: true, ignored: on, taskIds: ignores, todos: [] });
  };
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-todo-overview-qa') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-stats .directory-stat').length===5`));
    const cards = () => page.evaluate(`[...document.querySelectorAll('#directory-stats .directory-stat')]
      .map(el => [el.querySelector('span').textContent, el.querySelector('strong').textContent])`);
    const titles = () => page.evaluate(`[...document.querySelectorAll('#directory-task-list .directory-task-row strong')]
      .map(el => el.textContent).sort()`);
    // 「待办」= 等回答 + 未忽略的出错；被忽略的出错不在里面。异常两格误差都算。
    assert.deepEqual(await cards(), [
      ['进行中', '0'], ['待办', '2'], ['异常', '2'], ['今日完成', '0'], ['全部', '5'],
    ]);
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-status option[value="waiting"]')`), null,
      '「等待回复」档已并入待办');

    // 点「待办」卡：卡片数字与筛选列表同源，被忽略的出错不出现。
    await page.evaluate(`document.querySelectorAll('#directory-stats .directory-stat')[1].click()`);
    assert.equal(await page.evaluate(`document.getElementById('directory-task-status').value`), 'todo');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===2`),
      '待办卡的数字与列表条数一致');
    assert.deepEqual(await titles(), ['炸了的活', '等人回答的活']);
    assert.equal((await titles()).includes('忽略掉的出错'), false, '被忽略的出错不在待办里');
    await page.screenshot('directory-overview-todo.png');

    // 遗留的 waiting 值回落到同一份 isTodo（不再有一套「只筛 waiting」的死档）。
    const fallback = await page.evaluate(`(() => {
      const tasks = ${JSON.stringify(tasks)};
      return window.MultiCCAirAdmin.filterTasks(tasks, { status: 'waiting' }).map(task => task.id).sort();
    })()`);
    assert.deepEqual(fallback, ['tsk-err', 'tsk-wait'], '旧 waiting 值 = 待办口径（含出错，排除忽略）');

    // 点「异常」卡：被忽略过的出错仍在计数和列表里，行上仍是「取消忽略」。
    await page.evaluate(`document.querySelectorAll('#directory-stats .directory-stat')[2].click()`);
    assert.equal(await page.evaluate(`document.getElementById('directory-task-status').value`), 'error');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===2`));
    assert.deepEqual(await titles(), ['忽略掉的出错', '炸了的活']);
    const ignoredRow = await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#directory-task-list .directory-task-row')]
        .find(el => el.querySelector('strong').textContent === '忽略掉的出错');
      const button = row.querySelector('.task-ignore');
      return [button.textContent, button.getAttribute('aria-pressed')];
    })()`);
    assert.deepEqual(ignoredRow, ['取消忽略', 'true'], '被忽略的异常行仍可取消忽略');
    await page.screenshot('directory-overview-error.png');

    // 手机端同一份口径：待办不算被忽略的，异常仍算它。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.navigate('/air?dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-stats .directory-stat').length===5`));
    await page.screenshot('mobile-directory-overview.png');
    await page.navigate('/air');
    assert.ok(await page.waitFor(`document.querySelector('.mobile-console-filters [data-filter="error"]')`));
    assert.equal((await page.evaluate(`document.querySelector('.mobile-console-filters [data-filter="todo"]').textContent`)).endsWith(' 2'), true);
    assert.equal((await page.evaluate(`document.querySelector('.mobile-console-filters [data-filter="error"]').textContent`)).endsWith(' 2'), true,
      '手机端异常计数也含被忽略的出错任务');
    assert.equal(await page.evaluate(`document.querySelector('.mobile-console-filters [data-filter="waiting"]')`), null,
      '手机端不再有单独的「等待回复」格');
    await page.screenshot('mobile-overview-filters.png');

    // 回到桌面目录页，就地取消忽略：异常计数不变，但它重新回到待办。
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    // 整页导航换了 window，错误钩子要跟着重装（同上面那条测试）。
    await page.evaluate(String.raw`(() => {
      window.__errors = [];
      addEventListener('error', event => __errors.push(String(event.message)));
      addEventListener('unhandledrejection', event => __errors.push('unhandledrejection: ' + String(event.reason && event.reason.message)));
    })()`);
    await page.evaluate(`document.querySelectorAll('#directory-stats .directory-stat')[2].click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===2`));
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#directory-task-list .directory-task-row')]
        .find(el => el.querySelector('strong').textContent === '忽略掉的出错');
      row.querySelector('.task-ignore').click();
    })()`);
    assert.ok(await page.waitFor(`(() => {
      const row = [...document.querySelectorAll('#directory-task-list .directory-task-row')]
        .find(el => el.querySelector('strong').textContent === '忽略掉的出错');
      const button = row && row.querySelector('.task-ignore');
      return button && button.textContent === '忽略' && button.getAttribute('aria-pressed') === 'false';
    })()`));
    assert.deepEqual(ignores, []);
    assert.deepEqual(ignoreCalls, ['tsk-err-ignored']);
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-task-list .directory-task-row').length`), 2,
      '取消忽略后异常清单仍是两条');
    // 它重新回到待办：等回答 + 两条出错 = 3。
    await page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value='todo'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===3`));
    assert.ok((await titles()).includes('忽略掉的出错'), '取消忽略后回到待办');
    assert.deepEqual(await page.evaluate('window.__errors'), []);
  });
});
