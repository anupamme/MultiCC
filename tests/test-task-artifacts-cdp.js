'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');
const { collectTaskArtifacts } = require('../src/task-shell/artifacts');

test('artifact sidebar: real page, scoped links, dedupe, search, copy, persistence, refresh failure and mobile', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, screenshots = [], errors = [];
  let fail = false, failPatch = false;
  const entry = { ok: true, task: { id: 'tsk_a', title: '完善 MultiCC 任务会话' }, sessionId: 'task-a', ownerShellId: 'shell-a', readOnly: false,
    execution: { busy: false, status: 'idle' }, messages: [
      { role: 'user', taskId: 'tsk_a', content: '请整理本次交付的页面与测试结果。' },
      { role: 'assistant', taskId: 'tsk_a', content: '页面与测试结果已整理完成。\n\n[设计预览](/artifacts/preview/index.html)\n\n[测试结果](/artifacts/results/results.json)\n\n[旧版方案](/artifacts/old/index.html)', ts: Date.now() },
    ] };
  const registry = [
    { id: 'preview-id', kind: 'page', title: 'MultiCC Air · 任务产物边栏', url: '/artifacts/preview/index.html', taskId: 'tsk_a' },
    { kind: 'file', title: '浏览器验收结果.json', url: '/artifacts/results/results.json', taskId: 'tsk_a' },
    { kind: 'page', title: '旧版设计方案', url: '/artifacts/old/index.html', taskId: 'tsk_a' },
    { kind: 'page', title: 'OTHER TASK SECRET', url: '/artifacts/other/index.html', taskId: 'tsk_b' },
  ];
  const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const readArtifact = () => fail ? json({ error: 'offline' }, 503) : json(collectTaskArtifacts(entry, registry, id => id !== 'old'));
  routes['PATCH /api/docs-registry/preview-id'] = ({ body }) => {
    if (failPatch) return json({ error: 'failed' }, 503);
    Object.assign(registry[0], JSON.parse(body)); return json(registry[0]);
  };
  routes['POST /api/docs-registry'] = ({ body }) => {
    const update = JSON.parse(body), row = registry.find(item => item.url === update.url);
    Object.assign(row, update, { id: 'registered-id' }); return json(row, 201);
  };
  const publicDir = path.join(__dirname, '..', 'public');
  for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
    routes['/' + file] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } };
  }
  routes['/vendor/dompurify/purify.min.js'] = { body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')), headers: { 'content-type': 'text/javascript' } };
  routes['/auth-client.js'] = { body: '', headers: { 'content-type': 'text/javascript' } };
  routes['/api/task-shell-tasks/tsk_a'] = () => json(entry);
  routes['/api/task-shell-tasks/tsk_a/artifacts'] = readArtifact;
  routes['/api/task-shell-tasks/tsk_b/artifacts'] = () => json({ taskId: 'tsk_b', title: '空任务', items: [] });
  // Exercise the same full-chat scope callback without starting a CLI/websocket.
  routes['/chat.js'] = { headers: { 'content-type': 'text/javascript' }, body: `MultiCCChatShellEntry.createShellView({sourceSessionId:'a',request:async url=>url==='/api/task-shells'?{id:'shell-a'}:{activeSessionId:'task-a'}}).prepare();` };
  routes['/api/task-shells/shell-a/artifacts'] = readArtifact;
  routes['/artifacts/preview/index.html'] = '<h1>Artifact preview</h1>';
  routes['/artifacts/results/results.json'] = json({ passed: true });
  const screenshotDir = process.env.MULTICC_ARTIFACT_QA_DIR || path.join(os.tmpdir(), 'multicc-artifact-sidebar-qa');
  await withCdpHarness({ routes, screenshotDir }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('error',e=>{(window.__errors||=[]).push(e.message)});addEventListener('unhandledrejection',e=>{(window.__errors||=[]).push(String(e.reason))});` });
    await page.send('Network.setBlockedURLs', { urls: ['https://cdn.jsdelivr.net/*'] });
    const click = async selector => {
      const box = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
    };
    // Chat only renders inside Air, where the artifact toggle lives in the More
    // menu and the host page opens that menu through the frame's controller. The
    // fixture stubs chat.js, so it binds the same controller itself.
    const more = open => page.evaluate(`(window.__more ||= MultiCCChatLiveUi.bindHeaderMoreMenu({window,document,
      button:document.getElementById('header-more-btn'),menu:document.getElementById('header-more-menu'),
      wrap:document.getElementById('header-more-wrap')})).${open ? 'open' : 'close'}()`);
    const clickToggle = async () => { await more(true); await click('#task-artifacts-toggle'); await more(false); };
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    // 产物边栏只剩一个宿主：标准聊天页（Air 的任务面板嵌的就是它）。
    await page.navigate('/chat.html?session=a');
    assert.ok(await page.waitFor(`document.getElementById('task-artifacts-toggle')?.textContent==='产物 3'`));
    assert.equal(await page.evaluate(`document.getElementById('task-artifacts-panel').hidden`), true);
    await page.evaluate(`document.getElementById('input').value='保留我的草稿'`);
    await clickToggle();
    assert.equal(await page.evaluate(`document.getElementById('task-artifacts-toggle').getAttribute('aria-expanded')`), 'true');
    assert.equal(await page.evaluate(`getComputedStyle(document.body).paddingRight`), '310px');
    assert.equal(await page.evaluate(`document.getElementById('task-artifacts-list').innerText.includes('OTHER TASK')`), false);
    assert.equal(await page.evaluate(`document.querySelectorAll('.task-artifacts-expired').length`), 1);
    const links = await page.evaluate(`Array.from(document.querySelectorAll('.task-artifacts-link'),a=>({href:a.getAttribute('href'),target:a.target,rel:a.rel}))`);
    assert.equal(links.length, 3); assert.ok(links.every(a => a.target === '_blank' && a.rel.includes('noopener')));
    assert.equal(await page.evaluate(`fetch('/artifacts/preview/index.html').then(r=>r.status)`), 200);
    const previewRow = `Array.from(document.querySelectorAll('#task-artifacts-list li')).find(row => row.querySelector('a')?.href.includes('/preview/'))`;
    await page.evaluate(`${previewRow}.querySelector('[data-action="pinned"]').click()`);
    assert.ok(await page.waitFor(`${previewRow}.querySelector('[data-action="pinned"]').getAttribute('aria-pressed')==='true'`));
    assert.equal(registry[0].pinned, true); assert.equal(registry[0].permanent, undefined);
    await page.evaluate(`${previewRow}.querySelector('[data-action="permanent"]').click()`);
    assert.ok(await page.waitFor(`${previewRow}.querySelector('[data-action="permanent"]').getAttribute('aria-pressed')==='true'`));
    assert.equal(registry[0].permanent, true); assert.equal(registry[0].pinned, true);
    failPatch = true;
    await page.evaluate(`${previewRow}.querySelector('[data-action="permanent"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('.task-artifacts-status').textContent.includes('HTTP 503')`));
    assert.equal(registry[0].permanent, true, 'failed updates never change the flag');
    failPatch = false;
    await page.evaluate(`${previewRow}.querySelector('[data-action="pinned"]').click()`);
    assert.ok(await page.waitFor(`${previewRow}.querySelector('[data-action="pinned"]').getAttribute('aria-pressed')==='false'`));
    assert.equal(registry[0].permanent, true);
    screenshots.push(await page.screenshot('artifact-sidebar-desktop'));
    await page.evaluate(`document.querySelector('#task-artifacts-panel input').value='json';document.querySelector('#task-artifacts-panel input').dispatchEvent(new Event('input'))`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.task-artifacts-link').length`), 1);
    await page.evaluate(`navigator.clipboard.writeText=async text=>window.__copied=text`);
    await click('.task-artifacts-meta button');
    assert.ok((await page.evaluate('window.__copied')).endsWith('/artifacts/results/results.json'));
    await click('#task-artifacts-list [data-action="pinned"]');
    assert.ok(await page.waitFor(`document.querySelector('#task-artifacts-list [data-action="pinned"]').getAttribute('aria-pressed')==='true'`));
    assert.equal(registry[1].id, 'registered-id', 'unregistered transcript outputs can be registered from chat');
    assert.equal(registry[1].taskId, 'tsk_a');
    assert.equal(registry[1].sessionId, 'task-a');

    await click('#task-artifacts-close');
    assert.equal(await page.evaluate(`document.getElementById('task-artifacts-panel').hidden`), true);
    assert.equal(await page.evaluate(`document.getElementById('task-artifacts-toggle').getAttribute('aria-expanded')`), 'false');
    assert.equal(await page.evaluate(`document.getElementById('input').value`), '保留我的草稿');
    await clickToggle();
    await page.navigate('/chat.html?session=a');
    assert.ok(await page.waitFor(`document.getElementById('task-artifacts-panel')?.hidden===false`), 'expanded preference survives reload');
    registry.push({ kind: 'page', title: '<img src=x onerror=alert(1)>', taskId: 'tsk_a', url: '/artifacts/new/index.html' });
    await click('#task-artifacts-refresh');
    assert.ok(await page.waitFor(`document.querySelectorAll('.task-artifacts-link').length===4`));
    assert.equal(await page.evaluate(`document.querySelectorAll('#task-artifacts-list img').length`), 0);
    fail = true; await click('#task-artifacts-refresh');
    assert.ok(await page.waitFor(`document.querySelector('.task-artifacts-status').textContent.includes('加载失败')`));
    fail = false; await click('#task-artifacts-refresh');
    assert.ok(await page.waitFor(`document.querySelector('.task-artifacts-status').textContent===''`));
    await page.evaluate(`MultiCCTaskArtifacts.setScope({taskId:'tsk_b'})`);
    assert.ok(await page.waitFor(`document.getElementById('task-artifacts-toggle').textContent==='产物 0'`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.task-artifacts-link').length`), 0);
    await page.evaluate(`MultiCCTaskArtifacts.setScope({taskId:'tsk_a'})`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.task-artifacts-link').length===4`));
    registry[registry.length - 1].title = '补充说明';
    await page.evaluate('MultiCCTaskArtifacts.refresh()');
    for (const width of [390, 320]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      assert.equal(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
      assert.equal(await page.evaluate(`document.getElementById('task-artifacts-close').getBoundingClientRect().right<=innerWidth`), true);
      screenshots.push(await page.screenshot('artifact-sidebar-mobile-' + width));
    }
    errors.push(...await page.evaluate('window.__errors||[]'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/chat.html?session=a');
    assert.ok(await page.waitFor(`document.querySelector('#header-more-menu #task-artifacts-toggle')?.textContent==='产物 4'`));
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('task-artifacts-panel')).colorScheme`), 'light');
    screenshots.push(await page.screenshot('artifact-sidebar-full-chat'));
    // The fixture stubs only chat.js; unrelated full-chat modules may request
    // optional APIs. Sidebar errors are caught on the fully wired task page above.
  });
  assert.deepEqual(errors, []);
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.writeFileSync(path.join(screenshotDir, 'screenshots.json'), JSON.stringify(screenshots, null, 2));
});
