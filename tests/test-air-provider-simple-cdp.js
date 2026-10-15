'use strict';

// Provider 页的低频连接能力必须按“我要做什么”逐级展开。这里用真浏览器守住三件事：
// 账号从「更多连接方式」移入新增流程；该区只保留跨设备/原生登录，窄屏不撑破页面。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');
const { providerLimitBar } = require('../src/quota/quota-bar-view');

const json = body => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('Provider 更多连接方式以任务入口逐项展开，手机端保持单列', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const now = Date.now();
  const limit = (kind, windows) => ({ summaryText: '旧文案不应出现', fetchedAt: now - 60_000,
    bar: providerLimitBar({ kind, fetchedAt: now - 60_000, summary: { windows } }) });
  const routes = {};
  const publicDir = path.resolve(__dirname, '../public');
  for (const file of fs.readdirSync(publicDir).filter(name => /\.(js|css|html)$/.test(name))) {
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    routes[`/${file}`] = { body: fs.readFileSync(path.join(publicDir, file)), headers: { 'content-type': type } };
  }
  for (const file of fs.readdirSync(path.join(publicDir, 'shared')).filter(name => name.endsWith('.js'))) {
    routes[`/shared/${file}`] = { body: fs.readFileSync(path.join(publicDir, 'shared', file)), headers: { 'content-type': 'text/javascript' } };
  }
  routes['/air'] = routes['/air.html'];
  routes['/vendor/dompurify/purify.min.js'] = {
    body: fs.readFileSync(path.join(publicDir, 'vendor/dompurify/purify.min.js')),
    headers: { 'content-type': 'text/javascript' },
  };
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: 'window.multiccWsUrl=async url=>url' };

  const directory = { id: 'd1', name: 'MultiCC', path: '/projects/multicc' };
  routes['/api/air'] = () => json({ ok: true, directories: [directory], clis: ['claude', 'codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);
  routes['/api/providers'] = () => json({
    available: true,
    ccSwitchAvailable: false,
    ccSwitchStatus: { available: false, message: '未找到 cc-switch' },
    defaults: { claude: 'claude-official', codex: 'codex-official' },
    providers: [{
      id: 'claude-official', appType: 'claude', name: '同 Claude 终端', baseUrl: '',
      model: '', apiFormat: 'anthropic', hasToken: false, isOfficial: true, builtinOfficial: true,
      officialAccountId: null, modelOptions: [], compatibleClis: ['claude'],
      limit: limit('claude', [
        { window: '7d', label: 'Weekly', usedPercent: 36, resetMs: now + 3 * 86400000 },
        { window: '5h', label: 'Current session', usedPercent: 45, resetMs: now + 7200000 },
      ]),
    }, {
      id: 'codex-official', appType: 'codex', name: '同 Codex 终端', baseUrl: '',
      model: '', apiFormat: 'openai_responses', hasToken: false, isOfficial: true, builtinOfficial: true,
      officialAccountId: null, modelOptions: [], compatibleClis: ['codex'],
      limit: limit('codex', [{ window: '7d', usedPercent: 72, resetMs: now + 2 * 86400000 }]),
    }, {
      id: 'claude-official-aaaaaaaaaaaaaaaa', appType: 'claude', name: 'Claude 账号 · work', baseUrl: '',
      model: '', apiFormat: 'anthropic', hasToken: false, isOfficial: true, builtinOfficial: true,
      officialAccountId: 'aaaaaaaaaaaaaaaa', modelOptions: [], compatibleClis: ['claude'],
      limit: limit('claude', [{ window: '5h', usedPercent: 79, resetMs: now + 1800000 }]),
    }, {
      id: 'p1', appType: 'claude', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      model: 'glm-5.2', apiFormat: 'anthropic', hasToken: true, isOfficial: false,
      modelOptions: ['glm-5.2'], compatibleClis: ['claude'],
    }],
    stats: [],
  });
  routes['/api/token-usage/global'] = () => json({ windows: { today: {}, week: {}, month: {}, all: {} }, byDay: {}, byDayFresh: {} });
  routes['/api/token-usage/by-role'] = () => json({});
  routes['/api/codex/accounts'] = () => json({ accounts: [], cliLogin: null });
  routes['/api/claude/accounts'] = () => json({ accounts: [], cliLogin: null });

  await withCdpHarness({ routes, screenshotDir: path.join(os.tmpdir(), 'multicc-air-provider-simple-qa') }, async page => {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      Date.now = () => ${now};
      window.__quotaTicks = [];
      const originalInterval = window.setInterval;
      window.setInterval = (fn, ms, ...args) => {
        if (ms === 30000) window.__quotaTicks.push(fn);
        return originalInterval(fn, ms, ...args);
      };
    ` });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?view=provider&dir=d1');
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-provider-card').length===4`));
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.air-provider-card-head strong')].map(node=>node.textContent)`),
      ['同 Claude 终端', '同 Codex 终端', 'Claude 账号 · work', '智谱 GLM']);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.air-provider-card')].filter(card=>/同 (Claude|Codex) 终端/.test(card.innerText)).every(card=>![...card.querySelectorAll('button')].some(button=>button.textContent.trim()==='删除'))`), true);
    assert.equal(await page.evaluate(`(()=>{const card=[...document.querySelectorAll('.air-provider-card')].find(node=>node.innerText.includes('Claude 账号 · work'));return [...card.querySelectorAll('button')].some(button=>button.textContent.trim()==='删除')})()`), true,
      '独立登录账号和 API Key Provider 一样可以删除');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#air-provider-defaults option')].some(option=>option.value==='')`), false,
      '默认线路只出现真实卡片，不再重复一条“官方登录/订阅”空选项');
    const quotaCards = await page.evaluate(`[...document.querySelectorAll('.air-provider-limit')].map(node => ({text:node.textContent,title:node.title,color:node.style.color}))`);
    assert.equal(quotaCards[0].text, '5h 55% 2h · 1wk 64% 3d · 更新于 1 分钟前');
    assert.equal(quotaCards[1].text, '1wk 28% 2d · 更新于 1 分钟前');
    assert.equal(quotaCards[2].text, '5h 21% 30m · 更新于 1 分钟前');
    assert.match(quotaCards[0].title, /2h 后重置/);
    assert.equal(quotaCards[2].color, 'rgb(210, 153, 34)');
    await page.evaluate(`document.querySelector('#air-provider-cards').scrollIntoView({block:'start'})`);
    t.diagnostic(await page.screenshot('air-provider-quota-desktop'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await page.evaluate(`document.querySelector('.air-provider-card').scrollIntoView({block:'start'})`);
    t.diagnostic(await page.screenshot('air-provider-quota-mobile'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`Date.now=()=>${now + 1800000};window.__quotaTicks.forEach(fn=>fn())`);
    assert.equal(await page.evaluate(`document.querySelector('.air-provider-limit').textContent`),
      '5h 55% 1.5h · 1wk 64% 2d 23h · 更新于 31 分钟前');

    const cardActions = await page.evaluate(`[...document.querySelectorAll('.air-provider-card-actions button')].map(node => node.textContent.trim())`);
    assert.ok(cardActions.includes('共享到其他设备'), JSON.stringify(cardActions));
    assert.equal(cardActions.some(text => /借道/.test(text)), false);

    await page.evaluate(`[...document.querySelectorAll('#admin-actions button')].find(node => node.textContent.includes('更多连接方式')).click()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('.air-prov-adv-choice').length===2`));
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-prov-adv-panel:not([hidden])').length`), 0,
      '首次打开只问用户想做什么，不直接摊开复杂表单');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.air-prov-adv-choice strong')].map(node => node.textContent)`), [
      '连接或共享另一台设备',
      '单独登录 ZCode / Kimi',
    ]);

    await page.evaluate(`document.querySelector('.air-prov-adv-choice[data-section="device"]').click()`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.air-prov-adv-panel:not([hidden])').length`), 1);
    const visible = await page.evaluate(`document.querySelector('.air-prov-adv-panel:not([hidden])').textContent.replace(/\s+/g,' ').trim()`);
    assert.match(visible, /跨设备共享线路/);
    assert.match(visible, /使用其他设备的线路/);
    assert.match(visible, /查看共享记录/);
    assert.doesNotMatch(visible, /高级账号|借道|CPR|令牌/);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const mobile = await page.evaluate(`(() => {
      const choices = document.querySelector('.air-prov-adv-choices');
      return { columns: getComputedStyle(choices).gridTemplateColumns.split(' ').length,
        fits: document.documentElement.scrollWidth <= innerWidth,
        widths: [...choices.children].map(node => Math.round(node.getBoundingClientRect().width)) };
    })()`);
    assert.equal(mobile.columns, 1, JSON.stringify(mobile));
    assert.equal(mobile.fits, true, JSON.stringify(mobile));
    assert.ok(mobile.widths.every(width => width > 300), JSON.stringify(mobile));
    await page.evaluate(`document.getElementById('air-provider-advanced').scrollIntoView({block:'center'})`);
    assert.ok(await page.waitFor(`(()=>{const r=document.getElementById('air-provider-advanced').getBoundingClientRect();return r.top<innerHeight&&r.bottom>0})()`));
    t.diagnostic(await page.screenshot('air-provider-simple-mobile'));

    // App 的两个低频入口仍可深链直达；账号不再有隐藏深链入口。
    await page.navigate('/air?view=provider&dir=d1&providerConnection=device');
    assert.ok(await page.waitFor(`document.querySelector('.air-prov-adv-choice[data-section="device"].active') !== null`));
    assert.equal(await page.evaluate(`document.getElementById('air-provider-advanced').hidden`), false);
    assert.equal(await page.evaluate(`document.querySelector('.air-prov-adv-panel:not([hidden])').dataset.section`), 'device');

    await page.evaluate(`document.querySelector('#admin-actions .primary').click()`);
    assert.ok(await page.waitFor(`document.getElementById('air-provider-dialog').open===true`));
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.air-provider-create-choice strong')].map(node=>node.textContent)`),
      ['使用 API Key', '添加登录账号']);
    assert.equal(await page.evaluate(`document.getElementById('air-provider-api-fields').hidden`), true);
    await page.evaluate(`document.querySelector('[data-provider-account="claude"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('[data-k="label"]') !== null`), '账号入口直接进入创建并登录流程');
  });
});
