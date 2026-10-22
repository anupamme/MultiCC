'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

// 真实浏览器验证账号隔离与异步回填，不依赖生产服务器。
const publicDir = path.resolve(__dirname, '../public');
const json = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

const routes = {};
for (const file of fs.readdirSync(publicDir).filter(f => /\.(js|css|html)$/.test(f))) {
  routes['/' + file] = {
    body: fs.readFileSync(path.join(publicDir, file)),
    headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' },
  };
}
for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(f => f.endsWith('.js'))) {
  routes['/shared/' + file] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
}
routes['/auth-client.js'] = {
  headers: { 'content-type': 'text/javascript' },
  body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'`,
};
routes['/run-config-host.html'] = {
  headers: { 'content-type': 'text/html' },
  body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/run-config.css"><body>
${['auth-client.js', 'i18n-catalog.js', 'i18n.js', 'shared/dom-helpers.js', 'shared/format.js', 'api-client.js',
  'provider-catalog.js', 'auto-provider-editor.js', 'shared/models.js', 'chat-ai-config.js', 'run-config.js']
  .map(src => `<script src="/${src}"></script>`).join('')}</body>`,
};
routes['/api/sessions'] = () => json({ ok: true, sessions: [], directories: [] });
routes['/api/providers'] = () => json({ providers: [], defaults: {} });

const D = '.air-config-dialog[open] ';
const optionValues = `[...document.querySelectorAll(${JSON.stringify(D + '.rc-model option')})].map(o => o.value)`;
const accountA = 'codex-official-aaaaaaaaaaaaaaaa';
const accountB = 'codex-official-bbbbbbbbbbbbbbbb';
const official = (id, models) => ({ id, name: id, appType: 'codex', builtinOfficial: true,
  officialAccountId: id.slice(-16), modelOptions: models, model: models[0] || '',
  compatibleClis: ['codex', 'codex-exp'], protocol: 'openai_responses' });
const catalog = models => ({ models: models.map(model => ({ model, label: model })),
  source: 'account-cache', stale: false, diagnostic: { code: 'ok' } });
const changeLine = id => `(() => { const s=document.querySelector(${JSON.stringify(D + '.rc-line')}); s.value=${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`;

test('Codex账号目录后台回填、切换取消旧结果、借道隔离、重新打开检查升级', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  let completeA = false;
  const calls = [];
  const fixture = { ...routes,
    'GET /api/providers': () => json({ providers: [official(accountA, ['a-cached']), official(accountB, []),
      { id: 'relay', name: '借道', appType: 'codex', modelOptions: ['relay-model'],
        compatibleClis: ['codex', 'codex-exp'], protocol: 'openai_responses' }], defaults: { codex: accountA } }),
    'GET /api/codex/models': async ({ url }) => {
      const id = url.searchParams.get('providerId');
      calls.push({ id, poll: url.searchParams.get('poll') });
      if (id === accountA) return json({ ...catalog(completeA ? ['a-fresh'] : ['a-cached']), refreshing: !completeA });
      if (id === accountB) return json(catalog(['b-fresh']));
      return json({ error: 'unexpected account' }, 400);
    },
  };
  await withCdpHarness({ routes: fixture, screenshotDir: path.join(os.tmpdir(), 'multicc-codex-picker-qa') }, async page => {
    await page.navigate('/run-config-host.html');
    assert.ok(await page.waitFor('window.MultiCCRunConfig && window.watchCodexModels'));
    const open = `window.testDialog=MultiCCRunConfig.open({configuration:{cli:'codex-exp',provider:'${accountA}',model:'a-cached'}},['codex-exp'],()=>{})`;
    await page.evaluate(open);
    assert.ok(await page.waitFor(`${optionValues}.includes('a-cached')`), '缓存立即可见');
    assert.ok(await page.waitFor(`document.querySelector(${JSON.stringify(D + '.rc-model-status')}).textContent.includes('模型')`));
    // 后台刷新期间用户填写模型，回填后仍保持用户输入。
    await page.evaluate(`(() => { const s=document.querySelector(${JSON.stringify(D + '.rc-model')}); s.value='__custom__'; s.dispatchEvent(new Event('change')); const c=document.querySelector(${JSON.stringify(D + '.rc-model-custom')}); c.value='my-choice'; c.dispatchEvent(new Event('input')); })()`);
    completeA = true;
    assert.ok(await page.waitFor(`${optionValues}.includes('a-fresh')`));
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model-custom')}).value`), 'my-choice');
    assert.ok(calls.some(call => call.id === accountA && call.poll === '1'), '轮询只查询进度');
    await page.evaluate(changeLine(accountB));
    assert.ok(await page.waitFor(`${optionValues}.includes('b-fresh')`));
    assert.ok(!(await page.evaluate(optionValues)).includes('a-fresh'));
    await page.evaluate(changeLine('relay'));
    assert.ok(await page.waitFor(`${optionValues}.includes('relay-model')`));
    assert.ok(!calls.some(call => call.id === 'relay'), '借道目录不通过本机账号接口获取');
    await page.evaluate('window.testDialog.close()');
    const opens = calls.filter(call => call.id === accountA && !call.poll).length;
    await page.evaluate(open);
    assert.ok(await page.waitFor(`${optionValues}.includes('a-fresh')`));
    assert.ok(calls.filter(call => call.id === accountA && !call.poll).length > opens, '浏览器不节流，服务端每次检查CLI升级');
    await page.evaluate('window.testDialog.close()');
  });
});

test('Codex线路切换后迟到的旧账号响应不能覆盖当前模型', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  let releaseA;
  const pendingA = new Promise(resolve => { releaseA = resolve; });
  let requestedA = false;
  const fixture = { ...routes,
    'GET /api/providers': () => json({ providers: [official(accountA, ['a-cached']), official(accountB, [])], defaults: { codex: accountA } }),
    'GET /api/codex/models': async ({ url }) => {
      if (url.searchParams.get('providerId') === accountA) {
        requestedA = true;
        await pendingA;
        return json({ ...catalog(['a-late']), refreshing: true });
      }
      return json(catalog(['b-fresh']));
    },
  };
  try {
    await withCdpHarness({ routes: fixture, screenshotDir: path.join(os.tmpdir(), 'multicc-codex-picker-qa') }, async page => {
      await page.navigate('/run-config-host.html');
      assert.ok(await page.waitFor('window.MultiCCRunConfig && window.watchCodexModels'));
      await page.evaluate(`window.testDialog=MultiCCRunConfig.open({configuration:{cli:'codex-exp',provider:'${accountA}'}},['codex-exp'],()=>{})`);
      assert.ok(await page.waitFor(`${optionValues}.includes('a-cached')`));
      assert.ok(requestedA);
      await page.evaluate(changeLine(accountB));
      assert.ok(await page.waitFor(`${optionValues}.includes('b-fresh')`));
      releaseA();
      assert.ok(await page.waitFor(`window.readCodexModelCatalogSync({providerId:'${accountA}'})?.models[0]?.model === 'a-late'`));
      assert.ok(!(await page.evaluate(optionValues)).includes('a-late'));
      assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(D + '.rc-model')}).value`), 'b-fresh');
      await page.evaluate('window.testDialog.close()');
    });
  } finally { releaseA(); }
});
