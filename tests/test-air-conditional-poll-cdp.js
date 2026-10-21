'use strict';
// 真浏览器验证分页与 WebSocket：校准不重画，变更主动到达。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const etagFor = body => `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`;

test('Air 同步：1277 张卡按页读取，轻量校准不重画，推送及时更新', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)),
      headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
    routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };

  const polls = { total: 0, conditional: 0, notModified: 0 };
  let titles = ['任务 A'];
  const snapshot = JSON.stringify({
    ok: true, directories: [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }], clis: ['codex'],
    migration: { errors: [] }, sessions: [],
    tasks: Array.from({ length: 1277 }, (_, index) => ({ id: `tsk_${index}`, title: index ? `分页任务 ${index}` : '任务 A', status: 'active', dirId: 'd1', updatedAt: 3000 - index })),
  });
  let body = snapshot;
  routes['/api/air'] = ({ req }) => {
    polls.total++;
    const etag = etagFor(body);
    const sent = req.headers['if-none-match'];
    if (sent) polls.conditional++;
    if (sent === etag) { polls.notModified++; return { status: 304, headers: { etag }, body: '' }; }
    return { headers: { 'content-type': 'application/json', etag }, body };
  };
  routes['/api/settings/access-token'] = () => ({ headers: { 'content-type': 'application/json' }, body: '{"hasToken":true,"canEdit":false}' });
  routes['/api/cron'] = () => ({ headers: { 'content-type': 'application/json' }, body: '[]' });
  routes['/api/docs-registry'] = () => ({ headers: { 'content-type': 'application/json' }, body: '[]' });
  routes['/api/agent-presets'] = () => ({ headers: { 'content-type': 'application/json' }, body: '{"presets":[]}' });
  routes['/api/providers'] = () => ({ headers: { 'content-type': 'application/json' }, body: '{"ok":true,"available":false,"defaults":{},"providers":[]}' });

  await withCdpHarness({ routes, screenshotDir: process.env.MULTICC_AIR_POLL_QA_DIR || path.join(os.tmpdir(), 'multicc-air-poll-qa') }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>(window.__errors||=[]).push(e.message));addEventListener('unhandledrejection',e=>(window.__errors||=[]).push(String(e.reason)))` });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1');
    const rowText = `document.querySelector('#directory-task-list > *')?.textContent || ''`;
    assert.ok(await page.waitFor(`${rowText}.includes('任务 A')`), '首屏列出任务：' + await page.evaluate(rowText));
    // 给这一行盖个戳：只有真的重画了列表，这个标记才会跟着旧节点一起消失。
    assert.equal(await page.evaluate(`(() => { const row = document.querySelector('#directory-task-list > *'); row.dataset.airProbe = 'kept'; return row.dataset.airProbe; })()`), 'kept');

    await page.evaluate('Promise.all([MultiCCAirLive.sync(),MultiCCAirLive.sync()])');
    await sleep(300);
    assert.equal(page.requests.filter(r => r.path === '/api/air').length, 0, '新版首页不能下载全量快照');
    assert.ok(page.requests.some(r => r.path === '/api/air/sync' && r.url.includes('cursor=')), '校准只带游标');
    assert.equal(await page.evaluate(`document.querySelector('#directory-task-list > *')?.dataset.airProbe || ''`), 'kept', '无变化不能重画');
    assert.equal(await page.evaluate(`document.querySelectorAll('#directory-task-list > *').length`), 20);
    assert.ok((await page.evaluate(`document.querySelector('#directory-task-page')?.textContent || ''`)).includes('64'));
    await page.evaluate(`document.querySelector('#directory-task-next').click()`);
    assert.ok(await page.waitFor(`document.querySelector('#directory-task-list')?.textContent.includes('分页任务 20')`));
    await page.evaluate(`document.querySelector('#directory-task-prev').click()`);
    assert.ok(await page.waitFor(`${rowText}.includes('任务 A')`));

    // 模拟生产者发事件：fixture 定时读入源数据，客户端没有发起校准请求。
    titles = ['任务 A2'];
    body = JSON.stringify({
      ok: true, directories: [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }], clis: ['codex'],
      migration: { errors: [] }, sessions: [],
      tasks: [{ id: 'tsk_0', title: '任务 A2', status: 'active', dirId: 'd1', updatedAt: 2000 }],
    });
    assert.ok(await page.waitFor(`${rowText}.includes('任务 A2')`, { timeoutMs: 5000 }),
      '数据变了必须更新到界面上：' + await page.evaluate(rowText));
    assert.deepEqual(await page.evaluate('window.__errors || []'), []);
    await page.screenshot('01-air-incremental-sync');
    // 手机原来那一页「最近任务」并进了控制台的清单：一页 50 条、滚到底接下一页，不截条数。
    const mobileTasks = Array.from({ length: 120 }, (_, index) => ({ id: 'm' + index, title: '手机任务 ' + index,
      dirId: 'd1', status: 'active', runState: index === 0 ? 'error' : 'idle', updatedAt: 1000 + index }));
    const mobileSnapshot = () => ({ ok: true, directories: [{ id: 'd1', name: 'MultiCC', path: '/projects/multicc' }],
      tasks: mobileTasks, sessions: [], clis: ['codex'], migration: { errors: [] } });
    body = JSON.stringify(mobileSnapshot()); await sleep(200);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.navigate('/air?view=recent');
    const rows = `document.querySelectorAll('#console-task-list > *').length`;
    assert.ok(await page.waitFor(`${rows}===50`, { timeoutMs: 8000 }), '旧 view=recent 落到控制台，第一页 50 条');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('view')`), 'overview');
    await page.evaluate(`document.getElementById('console-task-more').scrollIntoView()`);
    assert.ok(await page.waitFor(`${rows}===100`, { timeoutMs: 8000 }), '滚到底接第二页');
    await page.evaluate(`document.getElementById('console-task-more').scrollIntoView()`);
    assert.ok(await page.waitFor(`${rows}===120`, { timeoutMs: 8000 }), '再接第三页，120 条全在');
    assert.equal(await page.evaluate(`document.getElementById('console-task-more').hidden`), true);
    await page.evaluate(`MultiCCAirLive.pause()`);
    mobileTasks[0].title = '断线后恢复的任务'; body = JSON.stringify(mobileSnapshot()); await sleep(250);
    assert.equal(await page.evaluate(`document.getElementById('console-task-list')?.textContent.includes('断线后恢复的任务')`), false);
    await page.evaluate(`MultiCCAirLive.resume()`);
    assert.ok(await page.waitFor(`document.getElementById('console-task-list')?.textContent.includes('断线后恢复的任务')`, { timeoutMs: 8000 }),
      '接上来的后续页也跟着同步更新');
    await page.evaluate(`document.querySelector('#console-task-filters [data-filter="error"]').click()`);
    assert.ok(await page.waitFor(`${rows}===1`, { timeoutMs: 8000 }));
    assert.equal(await page.evaluate(`document.querySelector('#console-task-list strong').textContent`), '断线后恢复的任务');
    assert.equal(page.requests.filter(r => r.path === '/api/air').length, 0);
    await page.screenshot('02-air-mobile-page-reconnect');
  });
});
