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
  const toggles = [];
  routes['/api/air'] = () => json({ ok: true, directories, clis: ['codex'], migration: { errors: [] }, tasks, sessions: [], taskTodos: todos });
  routes['/api/air/todos/toggle'] = ({ body }) => {
    const { taskId } = JSON.parse(body || '{}');
    toggles.push(taskId);
    todos = todos.includes(taskId) ? todos.filter(id => id !== taskId) : [...todos, taskId];
    return json({ ok: true, taskIds: todos });
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
    const pick = value => page.evaluate(`(() => { const s=document.getElementById('directory-task-status'); s.value=${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);

    assert.equal(await page.evaluate(`document.querySelector('#directory-task-status option').value`), 'todo', '待办是状态下拉的第一档');
    await pick('todo');
    assert.ok(await page.waitFor(`document.querySelectorAll('#directory-task-list .directory-task-row').length===4`));
    assert.deepEqual(await titles(), ['手动标的活', '炸了的活', '等人回答的活', '跑完要我确认的活']);
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
