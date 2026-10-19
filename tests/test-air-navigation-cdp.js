'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');
const json = value => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
function fixture() {
  const root = path.resolve(__dirname, '../public'), routes = {};
  for (const name of fs.readdirSync(root).filter(name => /\.(js|css|html)$/.test(name))) {
    routes['/' + name] = { body: fs.readFileSync(path.join(root, name)), headers: { 'content-type': (name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html') + '; charset=utf-8' } };
  }
  for (const name of fs.readdirSync(path.join(root, 'shared')).filter(name => name.endsWith('.js'))) {
    routes['/shared/' + name] = { body: fs.readFileSync(path.join(root, 'shared', name)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: 'window.multiccWsUrl=async url=>url' };
  const directories = [{ id: 'site', name: '官网', path: '/projects/site' }, { id: 'api', name: '后端服务', path: '/projects/api' }];
  const tasks = ['waiting', 'error', 'running', 'succeeded', 'idle', 'succeeded', 'idle'].map((state, i) => ({
    id: 'task-' + i, dirId: i % 2 ? 'api' : 'site', title: ['登录页改版', '每日数据报表', '接口文档补全', '订单导出改 CSV', '周报素材整理', 'README 补安装说明', '首页性能排查'][i],
    runState: state, status: state === 'succeeded' ? 'done' : 'active', updatedAt: Date.now() - i * 1000,
    resource: { residency: 'planned', lease: 'idle' },
  }));
  let configured = true;
  routes['/api/air'] = () => json({ ok: true, directories, tasks, clis: ['claude-exp', 'codex-exp'], migration: { errors: [] }, sessions: [] });
  routes['/api/fs/list'] = () => json({ base: '/projects', entries: [] });
  routes['POST /api/directories'] = req => { const input = JSON.parse(req.body); const value = { id: 'example', ...input }; directories.push(value); return json(value); };
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/aux/config'] = () => json({ providerId: configured ? 'p1' : '', cliAvailability: { claude: true, codex: true } });
  routes['/api/settings/power'] = () => json({ available: true, enabled: false, unlockPassword: { available: true, enabled: false, set: false } });
  routes['/api/providers'] = () => json({ available: true, defaults: {}, providers: [] });
  routes['/api/token-usage/global'] = () => json({ windows: { today: {}, week: {}, month: {}, all: {} }, byDay: {} });
  routes['/api/token-usage/by-role'] = () => json({});
  routes['/api/codex/accounts'] = routes['/api/claude/accounts'] = () => json({ accounts: [] });
  return { routes, directories, tasks, unconfigure: () => { configured = false; }, configure: () => { configured = true; } };
}
const shots = process.env.MULTICC_SESSION_ID
  ? path.join(os.homedir(), '.multicc/assist', process.env.MULTICC_SESSION_ID)
  : path.join(os.tmpdir(), 'multicc-navigation-qa');

test('Air preserves recent tasks and uses one settings home with browser-consistent return navigation', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const state = fixture();
  await withCdpHarness({ routes: state.routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air');
    await page.evaluate(`localStorage.setItem('air:recent-tasks', JSON.stringify(${JSON.stringify(state.tasks.map(task => task.id))})); location.reload()`);
    assert.ok(await page.waitFor(`document.querySelector('.console-priority-card') && document.querySelector('#tasks button')`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.console-priority-card').length`), 2);
    assert.equal(await page.evaluate(`document.querySelector('#task-title').textContent`), '控制台');
    assert.equal(await page.evaluate(`document.querySelector('#console-task-list').children.length`), 5);
    assert.equal(await page.evaluate(`document.querySelector('#sidebar-resources').open`), false);
    t.diagnostic(await page.screenshot('implemented-console'));
    await page.evaluate(`document.querySelector('#recent-all').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#console-task-list').children.length`), 7);
    await page.evaluate(`document.querySelector('#side-more').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=settings')`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-settings-categories button').length`), 5);
    assert.equal(await page.evaluate(`document.querySelector('#task-sidebar').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelector('#more-panel')`), null);
    t.diagnostic(await page.screenshot('implemented-settings'));
    await page.evaluate(`document.querySelector('[data-air-card="provider"]').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#page-back').textContent`), '‹ 设置');
    assert.ok(await page.waitFor(`document.querySelector('.air-provider') || document.querySelector('#air-provider-defaults')`));
    t.diagnostic(await page.screenshot('implemented-provider'));
    await page.evaluate(`location.reload()`);
    assert.ok(await page.waitFor(`document.querySelector('#page-back')?.textContent === '‹ 设置'`));
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=settings')`));
    await page.evaluate('history.forward()');
    assert.ok(await page.waitFor(`location.search.includes('view=provider')`));
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=settings')`));
    await page.evaluate(`document.querySelector('[data-category="airSettingsComputer"]').click()`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#air-lid-sleep').length`), 1);
    assert.ok(await page.waitFor(`!document.querySelector('#air-lid-sleep').hidden`));
    await page.evaluate(`document.querySelector('[data-air-card="global"]').click(); document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#admin-content #air-lid-sleep') !== null`));
    await page.evaluate(`document.querySelector('#library').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#library').getAttribute('aria-expanded')`), 'true');
    await page.evaluate(`const search = document.querySelector('#directory-flyout input'); search.value = '后端'; search.dispatchEvent(new Event('input'))`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.directory-flyout-row:not([hidden])').length`), 1);
    await page.evaluate(`document.querySelector('.directory-flyout-row:not([hidden])').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#task-title').textContent === '后端服务'`));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.evaluate(`document.querySelector('#mobile-nav').click(); document.querySelector('#library').click()`);
    assert.equal(await page.evaluate(`(() => { const r = document.querySelector('#directory-flyout').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`), true);
    t.diagnostic(await page.screenshot('implemented-project-mobile'));
    await page.evaluate(`document.querySelector('.directory-flyout-action').click()`);
    assert.equal(await page.evaluate(`document.body.classList.contains('nav-open')`), false);
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    t.diagnostic(await page.screenshot('implemented-console-mobile'));
    await page.navigate('/air?view=provider');
    assert.ok(await page.waitFor(`document.querySelector('#page-back')?.textContent === '‹ 设置'`));
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=settings')`));
  });
});

test('the three-step guide can be resumed after dismissing and reflects real setup state', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const state = fixture(); state.tasks.length = 0; state.directories.length = 0; state.unconfigure();
  await withCdpHarness({ routes: state.routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air');
    assert.ok(await page.waitFor(`!document.querySelector('#setup-card').hidden`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.setup-step.current').length`), 1);
    assert.equal(await page.evaluate(`document.querySelector('#onboarding-progress').textContent`), '0 / 3');
    assert.equal(await page.evaluate(`document.querySelector('#setup-first-task').disabled`), true);
    await page.evaluate(`document.querySelector('#setup-dismiss').click(); document.querySelector('#side-more').click(); document.querySelector('#onboarding-entry').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#setup-card').hidden`), false);
    await page.evaluate(`document.querySelector('#setup-provider').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#page-back').textContent`), '‹ 控制台');
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`!document.querySelector('#console-center').hidden`));
    t.diagnostic(await page.screenshot('implemented-onboarding'));
    await page.evaluate(`document.querySelector('#setup-example').click()`);
    assert.ok(await page.waitFor(`document.querySelector('dialog[open] input[placeholder]')?.value === '/projects/MultiCC-Example'`));
    assert.equal(page.requests.filter(request => request.path === '/api/directories' && request.method === 'POST').length, 0, 'example project waits for the save action');
    await page.evaluate(`document.querySelector('dialog[open] form').requestSubmit()`);
    assert.ok(await page.waitFor(`document.querySelector('#directory-name').textContent === '示例项目'`));
    await page.evaluate(`document.querySelector('#onboarding-entry').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#onboarding-progress').textContent`), '1 / 3');
    assert.equal(await page.evaluate(`document.querySelector('#setup-step-1').classList.contains('done')`), true);
    await page.evaluate(`document.querySelector('#setup-aux').click()`);
    state.configure();
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#onboarding-progress').textContent === '2 / 3'`), 'returning after saving rechecks configuration');
    await page.evaluate(`document.querySelector('#setup-first-task').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#quick-task-dialog').open`), true);


  });
});

test('手机底部导航保留最近任务、真实来路与项目切换', async t => {
  if (!findChromeBinary()) return t.skip('需要浏览器');
  const state = fixture();
  await withCdpHarness({ routes: state.routes, screenshotDir: shots }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.navigate('/air');
    assert.ok(await page.waitFor(`document.querySelector('#air-mobile-create') && document.querySelector('.mobile-console-recent')`));
    assert.equal(await page.evaluate(`document.querySelector('#air-mobile-dock').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelectorAll('[data-mobile-view]').length`), 4);
    assert.equal(await page.evaluate(`(() => {const tabs=[...document.querySelectorAll('[data-mobile-view]')].map(x=>x.getBoundingClientRect());return tabs.every(x=>Math.abs(x.top-tabs[0].top)<1) && tabs[3].right<=innerWidth;})()`), true);
    // 第 4 项「工作目录」直通 library 视图，目录首页（tasks）归它高亮。
    assert.equal(await page.evaluate(`document.querySelector('[data-mobile-view="library"]') != null`), true);
    await page.evaluate(`document.querySelector('[data-mobile-view="library"]').click()`);
    assert.ok(await page.waitFor(`!document.querySelector('#directory-library').hidden`), 'library tab opens the directory library');
    assert.equal(await page.evaluate(`document.querySelector('[data-mobile-view="library"]').classList.contains('active')`), true);
    await page.evaluate(`[...document.querySelectorAll('.directory-card button')].find(x => x.textContent.includes('${state.directories[0].name}')).click()`);
    assert.ok(await page.waitFor(`document.querySelector('#directory-mode')`), 'directory home reachable from library');
    assert.equal(await page.evaluate(`document.querySelector('[data-mobile-view="library"]').classList.contains('active')`), true, 'directory home highlights the library tab');
    // 回控制台继续原有的控制台断言。
    await page.evaluate(`document.querySelector('[data-mobile-view="overview"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.mobile-console-recent')`), 'back to console');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#mobile-nav')).display`), 'none');
    t.diagnostic(await page.screenshot('mobile-implemented-home'));
    // 控制台不分目录：顶栏没有目录按钮，卡片里两个项目的任务都在。
    assert.equal(await page.evaluate(`document.querySelector('#air-mobile-project').hidden`), true);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.mobile-console-filters button')].map(x=>x.dataset.filter)`),
      ['recent', 'todo', 'today', 'running', 'error']);
    const consoleIds = await page.evaluate(`[...document.querySelectorAll('.mobile-console-recent .mobile-task-row')].map(x=>x.dataset.taskId)`);
    assert.deepEqual(new Set(consoleIds.map(id => state.tasks.find(task => task.id === id).dirId)), new Set(['site', 'api']));
    const expectToday = state.tasks.filter(task => task.status === 'done').map(task => task.id);
    assert.ok(expectToday.length >= 2);
    await page.evaluate(`document.querySelector('.mobile-console-filters [data-filter="today"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.mobile-console-filters [data-filter="today"]')?.getAttribute('aria-pressed') === 'true'`));
    assert.deepEqual((await page.evaluate(`[...document.querySelectorAll('.mobile-console-recent .mobile-task-row')].map(x=>x.dataset.taskId)`)).sort(), [...expectToday].sort());
    assert.ok((await page.evaluate(`document.querySelector('.mobile-console-filters [data-filter="today"]').textContent`)).endsWith(` ${expectToday.length}`));
    assert.equal(await page.evaluate(`(() => { const b=document.querySelector('.mobile-console-filters [data-filter="today"]').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; })()`), true, 'today chip is visible without scrolling');
    t.diagnostic(await page.screenshot('mobile-console-today-filter'));
    await page.evaluate(`document.querySelector('.mobile-console-filters [data-filter="recent"]').click()`);
    await page.evaluate(`document.querySelector('[data-mobile-view="recent"]').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=recent') && document.querySelector('#mobile-task-search')`));
    assert.equal(await page.evaluate(`document.querySelector('#task-title').textContent`), '最近任务');
    // 最近任务默认看全部项目，顶栏按钮就是这一页的目录筛选。
    assert.equal(await page.evaluate(`document.querySelector('#air-mobile-project').textContent`), '全部项目 ⌄');
    assert.equal(await page.evaluate(`document.querySelectorAll('.mobile-task-list .mobile-task-row').length`), state.tasks.length);
    await page.evaluate(`const field=document.querySelector('#mobile-task-search'); field.value='登录';field.dispatchEvent(new Event('input'));`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.mobile-task-list .mobile-task-row').length`), 1);
    await page.evaluate(`document.querySelector('#air-mobile-settings').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#page-back').textContent`), '‹ 最近任务');
    assert.equal(await page.evaluate(`document.querySelector('#air-mobile-dock').hidden`), true);
    await page.evaluate(`document.querySelector('[data-category="airSettingsMobile"]').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#page-back').textContent`), '‹ 设置');
    assert.equal(await page.evaluate(`document.querySelector('#task-title').textContent`), '手机与通知');
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`!new URLSearchParams(location.search).has('category') && document.querySelector('#task-title').textContent === '设置'`));
    await page.evaluate(`document.querySelector('#page-back').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=recent') && document.querySelector('#mobile-task-search')?.value === '登录'`));
    await page.evaluate(`document.querySelector('#air-mobile-project').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#directory-flyout').hidden`), false);
    assert.equal(await page.evaluate(`(() => { const r=document.querySelector('#directory-flyout').getBoundingClientRect();return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`), true);
    await page.evaluate(`document.querySelector('#directory-flyout [data-dir-id="api"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#air-mobile-project').textContent.includes('后端服务')`));
    // 在最近任务里选目录：留在这一页，只列这个目录的任务；全局目录不动。
    assert.ok(await page.waitFor(`location.search.includes('view=recent') && document.querySelector('#mobile-task-search')`));
    await page.evaluate(`(() => { const field=document.querySelector('#mobile-task-search'); field.value='';field.dispatchEvent(new Event('input')); })()`);
    const apiIds = state.tasks.filter(task => task.dirId === 'api').map(task => task.id).sort();
    assert.deepEqual((await page.evaluate(`[...document.querySelectorAll('.mobile-task-list .mobile-task-row')].map(x=>x.dataset.taskId)`)).sort(), apiIds);
    t.diagnostic(await page.screenshot('mobile-recent-directory-filter'));
    // 控制台照旧跨目录；从「今日完成」的「全部 ›」进来，叠着这一页的目录筛选。
    await page.evaluate(`document.querySelector('[data-mobile-view="overview"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.mobile-console-filters') && document.querySelector('#air-mobile-project').hidden`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.mobile-console-recent .mobile-task-row').length`), 3);
    await page.evaluate(`document.querySelector('.mobile-console-filters [data-filter="today"]').click()`);
    await page.evaluate(`document.querySelector('.mobile-console-recent .mobile-section-head button').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.mobile-task-filters [data-filter="today"]')?.getAttribute('aria-pressed') === 'true'`));
    assert.deepEqual((await page.evaluate(`[...document.querySelectorAll('.mobile-task-list .mobile-task-row')].map(x=>x.dataset.taskId)`)).sort(),
      expectToday.filter(id => apiIds.includes(id)).sort());
    // 选回「全部项目」。
    await page.evaluate(`document.querySelector('#air-mobile-project').click()`);
    await page.evaluate(`[...document.querySelectorAll('#directory-flyout .directory-flyout-action')][0].click()`);
    assert.ok(await page.waitFor(`document.querySelector('#air-mobile-project').textContent === '全部项目 ⌄'`));
    assert.deepEqual((await page.evaluate(`[...document.querySelectorAll('.mobile-task-list .mobile-task-row')].map(x=>x.dataset.taskId)`)).sort(), [...expectToday].sort());
    // 新任务默认建到最近任务里选中的目录。
    await page.evaluate(`document.querySelector('#air-mobile-project').click()`);
    await page.evaluate(`document.querySelector('#directory-flyout [data-dir-id="api"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#air-mobile-project').textContent.includes('后端服务')`));
    await page.evaluate(`document.querySelector('#air-mobile-create').click()`);
    assert.equal(await page.evaluate(`document.querySelector('#quick-task-dialog').open`), true);
    assert.equal(await page.evaluate(`document.querySelector('#quick-task-dialog-directory').value`), 'api');
    await page.evaluate(`document.querySelector('#quick-task-dialog').close();document.querySelector('[data-mobile-view="schedules"]').click()`);
    assert.ok(await page.waitFor(`location.search.includes('view=schedules')`));
    for (const width of [360, 390, 430]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      assert.equal(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, `${width} 像素无横向溢出`);
      assert.equal(await page.evaluate(`document.querySelector('#air-mobile-dock').getBoundingClientRect().bottom <= innerHeight`), true);
    }
  });
});
