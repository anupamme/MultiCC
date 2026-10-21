'use strict';

// 钩子 / 触发器 UI 在真浏览器里跑一遍：
//   ① Air「定时任务」页的两个 tab：定时（原样）/ 触发器任务（列表、新建、编辑、测试、删除）；
//   ② 会话页头 🪝 按钮 + 共用规则表单（用最小页面挂载真实的 chat-hooks.js / hook-editor.js）；
//   ③ chat.html / chat.js 的接线是静态事实，直接读文件断言。
// 默认语言 zh，所以断言的是界面上的中文，顺带钉住文案接上了 i18n。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const PUBLIC = path.resolve(__dirname, '../public');
const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function staticRoutes() {
  const routes = {};
  for (const folder of ['', 'shared']) {
    for (const file of fs.readdirSync(path.join(PUBLIC, folder)).filter(f => /\.(js|css|html)$/.test(f))) {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      routes['/' + (folder ? folder + '/' : '') + file] = { body: fs.readFileSync(path.join(PUBLIC, folder, file)), headers: { 'content-type': type } };
    }
  }
  routes['/air'] = routes['/air.html'];
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  routes['/api/settings/access-token'] = () => json({ hasToken: true, canEdit: false });
  routes['/api/secrets'] = () => json([{ name: 'HOOK_SECRET' }]);
  routes['/api/directories'] = () => json([{ id: 'd1', name: '主仓' }, { id: 'd2', name: '营销仓' }]);
  routes['/api/events/catalog'] = () => json({ events: [], aliases: {}, actions: [], clis: ['claude', 'codex', 'opencode'] });
  // 注入目标只列聊天会话（task.sessionId）：终端、aux、归档、只读历史都不该出现。
  routes['/api/air'] = () => json({
    ok: true, directories: [{ id: 'd1', name: '主仓' }, { id: 'd2', name: '营销仓' }], clis: [], migration: { errors: [] },
    tasks: [
      { id: 'a', sessionId: 's1', title: '发布会话', dirId: 'd1', status: 'active', readOnly: false, lastMessageAt: 20 },
      { id: 'b', sessionId: 's2', title: '测试会话', dirId: 'd2', status: 'active', readOnly: false, lastMessageAt: 10 },
      { id: 'c', sessionId: 's3', title: '已归档', dirId: 'd1', status: 'archived', readOnly: true, lastMessageAt: 30 },
      { id: 'd', sessionId: null, title: '无会话的观察记录', dirId: 'd1', status: 'active', readOnly: false, lastMessageAt: 40 },
    ],
    sessions: [{ id: 'metaads', kind: 'terminal' }, { id: 'codex-acct-login-x', kind: 'terminal', label: 'Codex 登录 · x' }],
  });
  return routes;
}

const rule = over => ({
  id: 'r1', type: 'event', scope: 'global', name: '失败通知', enabled: true,
  on: ['task.attention'], filter: {}, action: { kind: 'notify', message: '' }, cooldownMs: 0, ...over,
});

function airRoutes(items) {
  const routes = staticRoutes();
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: '主仓', path: '/p' }], clis: ['claude-exp'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/providers'] = () => json({ available: false, providers: [], defaults: {} });
  routes['/api/agent-presets'] = () => json({ presets: [] });
  routes['/api/aux/config'] = () => json({ providerId: 'configured' });
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/cron'] = () => json([]);
  routes['/api/event-triggers'] = () => json({ items });
  routes['POST /api/event-rules'] = ({ body }) => {
    const draft = JSON.parse(body);
    items.push({ scope: 'global', sessionId: null, sessionLabel: null, rule: rule({ ...draft, id: 'r9' }), lastRun: null });
    return json(items[items.length - 1].rule);
  };
  routes['PUT /api/event-rules/r1'] = ({ body }) => { Object.assign(items[0].rule, JSON.parse(body)); return json(items[0].rule); };
  routes['DELETE /api/sessions/s1/triggers/t1'] = () => { items.splice(items.findIndex(i => i.rule.id === 't1'), 1); return json({ ok: true }); };
  routes['POST /api/events/test'] = () => json({ ok: true, eventId: 'e1' });
  return routes;
}

const aim = expr => `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
async function click(page, expr) {
  const point = await page.evaluate(aim(expr));
  assert.ok(point, `找不到可点的元素：${expr}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}
const requestsOf = (page, method, p) => page.requests.filter(r => r.method === method && r.path === p);
const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.includes(${JSON.stringify(text)}))`;

test('Air schedule center: tabs, trigger list, create / edit / test / delete', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const items = [
    { scope: 'global', sessionId: null, sessionLabel: null, rule: rule({}), lastRun: { ts: 1791950323952, ok: true, error: null } },
    { scope: 'session', sessionId: 's1', sessionLabel: '发布会话',
      rule: rule({ id: 't1', name: '', once: true, on: ['task.achieved'], action: { kind: 'inject-prompt', prompt: '继续部署' } }),
      lastRun: { ts: 1791950323952, ok: false, error: 'target busy or missing' } },
  ];
  await withCdpHarness({ routes: airRoutes(items), screenshotDir: path.join(os.tmpdir(), 'multicc-hooks-ui') }, async page => {
    await page.send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*'] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?view=schedules');
    assert.ok(await page.waitFor(`document.getElementById('schedule-center')?.hidden === false`));

    // 默认停在「定时任务」tab：原来的两块可见，触发器那块藏着，顶部按钮是原来的“新建定时任务”。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('[data-schedule-tab]')].map(b => [b.textContent, b.getAttribute('aria-selected')])`),
      [['定时任务', 'true'], ['触发器任务', 'false']]);
    assert.equal(await page.evaluate(`document.getElementById('hook-list').hidden`), true);
    assert.equal(await page.evaluate(`document.getElementById('schedule-list').hidden`), false);
    assert.match(await page.evaluate(`document.getElementById('schedule-create').textContent`), /新建定时任务/);

    // 切到「触发器任务」：列出全局 + 会话两条，顶部按钮改成“新建触发器”。
    await click(page, byText('[data-schedule-tab]', '触发器任务'));
    assert.ok(await page.waitFor(`document.querySelectorAll('#hook-list .schedule-card').length === 2`));
    assert.equal(await page.evaluate(`document.getElementById('schedule-list').hidden`), true);
    assert.match(await page.evaluate(`document.getElementById('schedule-create').textContent`), /新建触发器/);
    const cards = await page.evaluate(`[...document.querySelectorAll('#hook-list .schedule-card')].map(c => ({
      title: c.querySelector('h3').textContent, flow: c.querySelector('.hook-flow').textContent,
      owner: c.querySelector('.schedule-state span').textContent, last: c.querySelector('.schedule-state small').textContent,
      badges: [...c.querySelectorAll('.schedule-card-head .schedule-badge')].map(b => b.textContent),
      buttons: [...c.querySelectorAll('.schedule-actions button')].map(b => b.textContent) }))`);
    assert.equal(cards[0].title, '失败通知');
    assert.match(cards[0].flow, /需要我介入.*→.*通知我/);
    assert.equal(cards[0].owner, '全局');
    assert.match(cards[0].last, /成功/);
    assert.equal(cards[1].title, '达成目标', '没起名时用事件名当标题');
    assert.equal(cards[1].owner, '会话：发布会话');
    assert.match(cards[1].last, /失败 target busy/);
    assert.deepEqual(cards[1].badges, ['一次性', '已启用'], '一次性钩子在列表里必须一眼可见');
    assert.deepEqual(cards[0].badges, ['已启用'], '常驻钩子不加多余徽标');
    assert.deepEqual(cards[0].buttons, ['测试', '暂停', '编辑规则', '删除规则']);
    await page.screenshot('triggers-tab.png');

    // 新建：范围默认全局；选 webhook + 地址 + 带结论，保存 → POST /api/event-rules。
    await click(page, `document.getElementById('schedule-create')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    assert.equal(await page.evaluate(`document.querySelector('.hook-dialog').matches(':modal')`), true);
    await page.evaluate(`(() => { const f = document.querySelector('.hook-dialog form');
      f.elements.name.value = '发布完成'; f.querySelectorAll('input[name=ev]').forEach(b => { b.checked = b.value === 'task.achieved'; });
      f.elements.kind.value = 'webhook'; f.elements.kind.onchange();
      f.elements.url.value = 'https://hooks.example.com/x'; f.elements.secretName.value = 'HOOK_SECRET';
      f.elements.includeConclusion.checked = true; f.elements.cooldown.value = '30'; })()`);
    assert.equal(await page.evaluate(`document.querySelector('.hook-dialog [data-kind=webhook]').hidden`), false);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.hook-dialog [data-kind=notify]')).display`), 'none', '只显示当前动作的字段');
    await page.screenshot('editor-webhook.png');
    await click(page, `document.getElementById('hook-save')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog').open === false`));
    const created = requestsOf(page, 'POST', '/api/event-rules');
    assert.equal(created.length, 1);
    assert.deepEqual(JSON.parse(created[0].body), {
      type: 'event', name: '发布完成', on: ['task.achieved'], filter: {},
      action: { kind: 'webhook', url: 'https://hooks.example.com/x', secretName: 'HOOK_SECRET', includeConclusion: true }, then: [],
      enabled: true, once: false, cooldownMs: 30000,
    });
    assert.ok(await page.waitFor(`document.querySelectorAll('#hook-list .schedule-card').length === 3`), '保存后列表自己刷新');

    // 校验：一个事件都没选就保存，红字提示，不发请求。
    await click(page, `document.getElementById('schedule-create')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    await page.evaluate(`document.querySelectorAll('.hook-dialog input[name=ev]').forEach(b => { b.checked = false; })`);
    await click(page, `document.getElementById('hook-save')`);
    assert.ok(await page.waitFor(`document.getElementById('hook-error').textContent.includes('至少选择一个事件')`));
    assert.equal(requestsOf(page, 'POST', '/api/event-rules').length, 1);
    await click(page, `document.getElementById('hook-cancel')`);

    // 编辑：带出已有值，范围锁定；改名后 PUT 到同一条。
    await click(page, byText('#hook-list .schedule-card:first-child .schedule-actions button', '编辑'));
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    assert.deepEqual(await page.evaluate(`(() => { const f = document.querySelector('.hook-dialog form');
      return { title: document.getElementById('hook-title').textContent, name: f.elements.name.value, kind: f.elements.kind.value,
        scopeLocked: f.elements.scope.disabled, on: [...f.querySelectorAll('input[name=ev]:checked')].map(b => b.value) }; })()`),
    { title: '编辑钩子', name: '失败通知', kind: 'notify', scopeLocked: true, on: ['task.attention'] });
    await page.evaluate(`document.querySelector('.hook-dialog form').elements.name.value = '失败通知 v2'`);
    await click(page, `document.getElementById('hook-save')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog').open === false`));
    assert.equal(JSON.parse(requestsOf(page, 'PUT', '/api/event-rules/r1')[0].body).name, '失败通知 v2');

    // 测试：要二次确认；确认后 POST /api/events/test，带上规则对应的事件与会话。
    await page.evaluate(`window.confirm = () => true`);
    await click(page, byText('#hook-list .schedule-card:nth-child(2) .schedule-actions button', '测试'));
    assert.ok(await page.waitFor(`document.getElementById('hook-list') && true`));
    await page.waitFor(`true`);
    const tests = requestsOf(page, 'POST', '/api/events/test');
    assert.equal(tests.length, 1);
    assert.deepEqual(JSON.parse(tests[0].body), { type: 'task.achieved', sessionId: 's1', goalState: 'achieved', goal: '（测试事件）' });

    // 删除会话级那条：走会话触发器的 DELETE。
    await click(page, byText('#hook-list .schedule-card:nth-child(2) .schedule-actions button', '删除'));
    assert.ok(await page.waitFor(`document.querySelectorAll('#hook-list .schedule-card').length === 2`));
    assert.equal(requestsOf(page, 'DELETE', '/api/sessions/s1/triggers/t1').length, 1);

    // 切回「定时任务」：顶部按钮复原。
    await click(page, byText('[data-schedule-tab]', '定时任务'));
    assert.equal(await page.evaluate(`document.getElementById('hook-list').hidden`), true);
    assert.match(await page.evaluate(`document.getElementById('schedule-create').textContent`), /新建定时任务/);
  });
});

test('chat header hook button: count badge and the shared form scoped to this session', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = staticRoutes();
  const triggers = [{ id: 't1', type: 'event', enabled: true, on: ['task.failed'], filter: {}, action: { kind: 'notify' } },
    { id: 't2', type: 'post-turn', enabled: true }, { id: 't3', type: 'event', enabled: false, on: ['task.failed'], filter: {}, action: { kind: 'notify' } }];
  routes['/api/sessions/s1/triggers'] = () => json({ triggers });
  routes['POST /api/sessions/s1/triggers'] = ({ body }) => { triggers.push({ ...JSON.parse(body), id: 't9', enabled: true }); return json({ id: 't9' }); };
  routes['/stub.html'] = { headers: { 'content-type': 'text/html' }, body: `<!doctype html><meta charset="utf-8"><body>
    <button id="hook-btn" class="hdr-btn session-only" data-i18n="hookTitle">钩子</button>
    <script src="/i18n-catalog.js"></script><script src="/i18n.js"></script><script src="/error-envelope.js"></script>
    <script src="/api-client.js"></script><script src="/hook-editor.js"></script><script src="/chat-hooks.js"></script>
    <script>window.MultiCCChatHooks.refresh('s1');</script></body>` };
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-hooks-ui') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/stub.html?session=s1');
    // 只数启用的 event 触发器：post-turn 不算，停用的不算。
    assert.ok(await page.waitFor(`document.getElementById('hook-btn').textContent === '钩子 1'`),
      await page.evaluate(`document.getElementById('hook-btn').textContent`));
    assert.equal(await page.evaluate(`document.getElementById('hook-btn').dataset.state`), 'set');
    assert.match(await page.evaluate(`document.getElementById('hook-btn').title`), /已启用 1 个/);

    // 已有钩子：先列出来（启用 + 停用的 event 钩子都在，post-turn 不在），能看能改，再从这里新建。
    await click(page, `document.getElementById('hook-btn')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-list-dialog')?.open === true`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.hook-list-dialog .hook-list-item').length`), 2);
    assert.equal(await page.evaluate(`document.querySelectorAll('.hook-list-dialog .hook-list-item.off').length`), 1);
    assert.match(await page.evaluate(`document.querySelector('.hook-list-dialog').textContent`), /编辑规则/);
    await click(page, `[...document.querySelectorAll('.hook-list-dialog button')].find(b => b.textContent === '新建钩子')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    assert.equal(await page.evaluate(`document.querySelector('.hook-list-dialog').open`), false);
    // 会话入口：不出现“作用范围”，因为归属已固定为本会话。
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('hook-scope-row')).display`), 'none');
    // 「注入到」三选一：触发事件的会话 / 新建会话 / 指定会话（会话页头入口也能选其它会话）。
    await page.evaluate(`(() => { const f = document.querySelector('.hook-dialog form');
      f.querySelectorAll('input[name=ev]').forEach(b => { b.checked = b.value === 'task.done'; });
      f.elements.kind.value = 'inject-prompt'; f.elements.kind.onchange(); f.elements.prompt.value = '整理发布说明';
      f.elements.once.checked = true; })()`);
    assert.deepEqual(await page.evaluate(`[...document.querySelector('.hook-dialog form').elements.target.options].map(o => [o.value, o.textContent])`), [
      ['', '触发事件的会话'], ['__new__', '新建会话（每次触发新建一个）'], ['s1', '发布会话（主仓）'], ['s2', '测试会话（营销仓）']]);
    assert.ok(!(await page.evaluate(`document.querySelector('.hook-dialog form').elements.target.textContent`)).match(/metaads|登录|已归档|观察记录/), '终端/归档/无会话的不出现');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('.hook-dialog [data-newsession]')).display`), 'none', '没选新建会话时不露出工作区/CLI');
    await page.evaluate(`(() => { const f = document.querySelector('.hook-dialog form'); f.elements.target.value = '__new__'; f.elements.target.onchange(); })()`);
    assert.notEqual(await page.evaluate(`getComputedStyle(document.querySelector('.hook-dialog [data-newsession]')).display`), 'none');
    assert.deepEqual(await page.evaluate(`[...document.querySelector('.hook-dialog form').elements.newDir.options].map(o => [o.value, o.textContent])`),
      [['', '触发事件所在的工作区'], ['d1', '主仓'], ['d2', '营销仓']]);
    assert.deepEqual(await page.evaluate(`[...document.querySelector('.hook-dialog form').elements.newCli.options].map(o => o.value)`), ['', 'claude', 'codex', 'opencode']);
    await page.evaluate(`(() => { const f = document.querySelector('.hook-dialog form'); f.elements.newDir.value = 'd2'; f.elements.newCli.value = 'codex'; f.elements.newTitle.value = '发布说明'; })()`);
    await page.screenshot('chat-hook-editor.png');
    await click(page, `document.getElementById('hook-save')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog').open === false`));
    const posted = requestsOf(page, 'POST', '/api/sessions/s1/triggers');
    assert.equal(posted.length, 1);
    assert.deepEqual(JSON.parse(posted[0].body), {
      type: 'event', name: '', on: ['task.done'], filter: {},
      action: { kind: 'inject-prompt', prompt: '整理发布说明', newSession: { dirId: 'd2', cli: 'codex', title: '发布说明' } }, then: [], enabled: true,
      once: true,
    }, '一次性开关随表单一起提交');
    assert.ok(await page.waitFor(`document.getElementById('hook-btn').textContent === '钩子 2'`), '保存后角标自己刷新');
  });
});

test('hook form: chained steps are listed, edited in order, and kept when not editable', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = staticRoutes();
  const chain = { id: 't1', type: 'event', enabled: true, on: ['task.finished'], filter: {},
    action: { kind: 'inject-prompt', prompt: '先写方案' },
    then: [{ kind: 'inject-prompt', prompt: '按方案实现' }, { kind: 'notify', message: '完成' }] };
  routes['/api/sessions/s1/triggers'] = () => json({ triggers: [chain] });
  routes['PUT /api/sessions/s1/triggers/t1'] = ({ body }) => json({ ...chain, ...JSON.parse(body) });
  routes['/stub.html'] = { headers: { 'content-type': 'text/html' }, body: `<!doctype html><meta charset="utf-8"><body>
    <button id="hook-btn">钩子</button>
    <script src="/i18n-catalog.js"></script><script src="/i18n.js"></script><script src="/error-envelope.js"></script>
    <script src="/api-client.js"></script><script src="/hook-editor.js"></script><script src="/chat-hooks.js"></script></body>` };
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-hooks-ui') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/stub.html?session=s1');
    await click(page, `document.getElementById('hook-btn')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-list-dialog')?.open === true`));
    // 列表里按序号列出后续步骤；非注入步骤显示动作名。
    const prompts = await page.evaluate(`[...document.querySelectorAll('.hook-list-dialog .hook-list-prompt')].map(p => p.textContent)`);
    assert.deepEqual(prompts.slice(0, 2), ['先写方案', '2. 按方案实现']);
    assert.match(await page.evaluate(`document.querySelectorAll('.hook-list-dialog .hook-list-prompt')[2].textContent`), /^3\. /);
    await click(page, `[...document.querySelectorAll('.hook-list-dialog button')].find(b => b.textContent === '编辑规则')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    // 编辑：可编辑的注入步骤带出原指令，通知步骤原样保留、只显示说明。
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.hook-dialog .hook-chain-step')].map(r => [r.querySelector('b').textContent, r.querySelector('textarea') ? r.querySelector('textarea').value : 'kept'])`),
      [['2.', '按方案实现'], ['3.', 'kept']]);
    // 加一步但不填 → 拦下；填上后保存，顺序与保留的通知步骤都在请求体里。
    await click(page, `document.getElementById('hook-chain-add')`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.hook-dialog .hook-chain-step').length`), 3);
    assert.equal(await page.evaluate(`document.querySelectorAll('.hook-dialog .hook-chain-step')[2].querySelector('textarea').placeholder`), '第 4 步的指令');
    await click(page, `document.getElementById('hook-save')`);
    assert.ok(await page.waitFor(`document.getElementById('hook-error').textContent === '后续步骤的指令不能为空'`));
    await page.evaluate(`document.querySelectorAll('.hook-dialog .hook-chain-step')[2].querySelector('textarea').value = '跑测试并汇报'`);
    await page.screenshot('hook-chain-editor.png');
    await click(page, `document.getElementById('hook-save')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog').open === false`));
    assert.deepEqual(JSON.parse(requestsOf(page, 'PUT', '/api/sessions/s1/triggers/t1')[0].body).then,
      [{ kind: 'inject-prompt', prompt: '按方案实现' }, { kind: 'notify', message: '完成' }, { kind: 'inject-prompt', prompt: '跑测试并汇报' }]);
    // 删掉一步后编号重排。
    await click(page, `document.getElementById('hook-btn')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-list-dialog')?.open === true`));
    await click(page, `[...document.querySelectorAll('.hook-list-dialog button')].find(b => b.textContent === '编辑规则')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    await click(page, `document.querySelector('.hook-dialog .hook-chain-step button')`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.hook-dialog .hook-chain-step b')].map(b => b.textContent)`), ['2.']);
  });
});

test('hook form: inject into a specific session, and blank new-session follows the source', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = staticRoutes();
  routes['/api/sessions/s1/triggers'] = () => json({ triggers: [] });
  routes['POST /api/sessions/s1/triggers'] = () => json({ id: 't9' });
  routes['/stub.html'] = { headers: { 'content-type': 'text/html' }, body: `<!doctype html><meta charset="utf-8"><body>
    <button id="hook-btn">钩子</button>
    <script src="/i18n-catalog.js"></script><script src="/i18n.js"></script><script src="/error-envelope.js"></script>
    <script src="/api-client.js"></script><script src="/hook-editor.js"></script><script src="/chat-hooks.js"></script></body>` };
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-hooks-ui') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/stub.html?session=s1');
    const fill = (target) => page.evaluate(`(() => { const f = document.querySelector('.hook-dialog form');
      f.querySelectorAll('input[name=ev]').forEach(b => { b.checked = b.value === 'task.failed'; });
      f.elements.kind.value = 'inject-prompt'; f.elements.kind.onchange(); f.elements.prompt.value = 'p';
      f.elements.target.value = ${JSON.stringify(target)}; f.elements.target.onchange(); })()`);

    await click(page, `document.getElementById('hook-btn')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    await fill('s2');
    await click(page, `document.getElementById('hook-save')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog').open === false`));
    assert.deepEqual(JSON.parse(requestsOf(page, 'POST', '/api/sessions/s1/triggers')[0].body).action, { kind: 'inject-prompt', prompt: 'p', targetSessionId: 's2' });

    // 新建会话但工作区/CLI 都留空 = 沿用来源会话（后端在触发时解析），请求体里是空串。
    await click(page, `document.getElementById('hook-btn')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    await fill('__new__');
    await click(page, `document.getElementById('hook-save')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog').open === false`));
    assert.deepEqual(JSON.parse(requestsOf(page, 'POST', '/api/sessions/s1/triggers')[1].body).action,
      { kind: 'inject-prompt', prompt: 'p', newSession: { dirId: '', cli: '', title: '' } });
  });
});

test('hook form: many sessions are searchable by title or workspace; pinned and selected stay', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = staticRoutes();
  // 120 个会话：序号 0..119，奇数在「主仓」、偶数在「营销仓」，标题 会话-<n>。
  routes['/api/air'] = () => json({
    ok: true, directories: [{ id: 'd1', name: '主仓' }, { id: 'd2', name: '营销仓' }], clis: [], migration: { errors: [] },
    tasks: Array.from({ length: 120 }, (_, n) => ({ id: `t${n}`, sessionId: `s${n}`, title: `会话-${n}`,
      dirId: n % 2 ? 'd1' : 'd2', status: 'active', readOnly: false, lastMessageAt: 1000 - n })),
    sessions: [],
  });
  routes['/api/sessions/s0/triggers'] = () => json({ triggers: [] });
  routes['POST /api/sessions/s0/triggers'] = () => json({ id: 't9' });
  routes['/stub.html'] = { headers: { 'content-type': 'text/html' }, body: `<!doctype html><meta charset="utf-8"><body>
    <button id="hook-btn">钩子</button>
    <script src="/i18n-catalog.js"></script><script src="/i18n.js"></script><script src="/error-envelope.js"></script>
    <script src="/api-client.js"></script><script src="/hook-editor.js"></script><script src="/chat-hooks.js"></script></body>` };
  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-hooks-ui') }, async page => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/stub.html?session=s0');
    await click(page, `document.getElementById('hook-btn')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog')?.open === true`));
    const F = `document.querySelector('.hook-dialog form')`;
    const options = () => page.evaluate(`[...${F}.elements.target.options].map(o => o.value)`);
    const filter = text => page.evaluate(`(() => { const f = ${F}; f.elements.targetFilter.value = ${JSON.stringify(text)}; f.elements.targetFilter.oninput(); })()`);
    await page.evaluate(`(() => { const f = ${F}; f.elements.kind.value = 'inject-prompt'; f.elements.kind.onchange(); })()`);

    assert.equal((await options()).length, 122, '不再截断：120 个会话 + 沿用 + 新建');
    assert.equal(await page.evaluate(`getComputedStyle(${F}.elements.targetFilter).display`) === 'none', false, '会话多时露出搜索框');

    await filter('会话-11');   // 会话-11 / 会话-110..119
    const hit = await options();
    assert.deepEqual(hit.slice(0, 2), ['', '__new__'], '沿用 / 新建 始终保留在最前');
    assert.deepEqual(hit.slice(2), ['s11', ...Array.from({ length: 10 }, (_, n) => `s${110 + n}`)]);

    await filter('营销仓');    // 按工作区名搜：偶数序号
    assert.equal((await options()).length, 2 + 60);
    await filter('不存在的词');
    assert.deepEqual(await options(), ['', '__new__'], '没有匹配时只剩固定项');

    // 先选中再收窄：当前选中项不会被过滤掉。
    await filter('');
    await page.evaluate(`(() => { const f = ${F}; f.elements.target.value = 's5'; })()`);
    await filter('营销仓');
    assert.ok((await options()).includes('s5'), '当前选中的 s5 在「营销仓」过滤下仍保留');
    assert.equal(await page.evaluate(`${F}.elements.target.value`), 's5');

    // 过滤后选另一项并保存：请求体里是它的 id。
    await page.evaluate(`(() => { const f = ${F}; f.querySelectorAll('input[name=ev]').forEach(b => { b.checked = b.value === 'task.failed'; });
      f.elements.prompt.value = 'p'; f.elements.target.value = 's40'; })()`);
    await click(page, `document.getElementById('hook-save')`);
    assert.ok(await page.waitFor(`document.querySelector('.hook-dialog').open === false`));
    assert.equal(JSON.parse(requestsOf(page, 'POST', '/api/sessions/s0/triggers')[0].body).action.targetSessionId, 's40');
  });
});

test('chat.html and chat.js wire the hook button, scripts and refresh call', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'chat.html'), 'utf8');
  const chat = fs.readFileSync(path.join(PUBLIC, 'chat.js'), 'utf8');
  assert.match(html, /<button class="hdr-btn session-only" id="hook-btn" data-hdr-icon="🪝"/);
  assert.ok(html.indexOf('hook-editor.js') > html.indexOf('api-client.js'), '编辑器依赖 api-client');
  assert.ok(html.indexOf('chat-hooks.js') > html.indexOf('hook-editor.js'));
  assert.ok(html.indexOf('chat-hooks.js') < html.indexOf('<script src="chat.js">'), 'chat.js 调用 refresh 之前它得已存在');
  assert.match(chat, /'hook-btn', 'auto-commit-btn'/, '钩子按钮进页头“更多”菜单');
  assert.match(chat, /MultiCCChatHooks\?\.refresh\(_sessionName\)/);
  const air = fs.readFileSync(path.join(PUBLIC, 'air.html'), 'utf8');
  assert.ok(air.indexOf('<script src="hook-editor.js">') < air.indexOf('<script src="air-trigger-center.js">'));
  assert.ok(air.indexOf('<script src="air-schedule-center.js">') < air.indexOf('<script src="air-trigger-center.js">'), '触发器 tab 要在 bind 之前拿到定时中心已绑好的按钮');
  assert.match(fs.readFileSync(path.join(PUBLIC, 'air.js'), 'utf8'), /MultiCCAirHooks\?\.bind\(/);
});
