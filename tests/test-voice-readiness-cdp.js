'use strict';
// 「语音输入还没准备好」在真浏览器里走一遍：
//   ① 麦克风（voice-composer.js + voice-readiness.js）：没有可用识别时点麦克风，不录音、
//      直接弹引导卡；卡里点「下载离线模型」→ 进度条 → 服务端说装好 → 卡片说可以用了；
//   ② Air 语音设置（air-voice.js）：同样的状态下面板顶上挂提示条、ASR 那块自动展开；
//      提示条上能直接下载；下载中那颗按钮点下去发的是 cancel（此前它永远发 download）。
// 文案断言不写死：先在页面里取回 t(key) 再比。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { withCdpHarness, findChromeBinary } = require('./helpers/cdp-harness');

const TOTAL = 240193589;

test('voice not set up: the mic offers the offline model in place, and the settings panel says the same', async t => {
  if (!findChromeBinary()) return t.skip('Chrome required');
  const routes = {}, publicDir = path.resolve(__dirname, '../public');
  const shots = path.join(os.tmpdir(), 'multicc-voice-readiness-qa');
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
  routes['/auth-client.js'] = { headers: { 'content-type': 'text/javascript' }, body: `window.multiccWsUrl=async url=>url+(url.includes('?')?'&':'?')+'ticket=fixture'` };
  routes['/mic.html'] = { headers: { 'content-type': 'text/html' }, body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
<textarea id="in"></textarea><button id="mic">mic</button><div id="toast"></div>
<script src="/i18n-catalog.js"></script><script src="/i18n.js"></script><script src="/shared/format.js"></script>
<script src="/voice-readiness.js"></script><script src="/voice-composer.js"></script>
<script>window.vc = MultiCCVoiceComposer.createVoiceComposer({ input: document.getElementById('in'),
  micButton: document.getElementById('mic'), micToast: document.getElementById('toast') });</script></body></html>` };

  // ── 服务端状态：一份本地模型安装进度，两条接口共用 ──────────────────────
  const model = { state: 'missing', percent: 0 };
  const download = () => ({
    state: model.state, ready: model.state === 'ready', percent: model.percent, totalBytes: TOTAL,
    doneBytes: Math.round(TOTAL * model.percent / 100),
    bytesPerSec: model.state === 'downloading' ? 5 * 1048576 : 0, etaSec: model.state === 'downloading' ? 28 : 0,
  });
  const readiness = () => ({
    ready: model.state === 'ready', engine: model.state === 'ready' ? 'local' : null,
    reason: model.state === 'ready' ? null : model.state, cloudConfigured: false, download: download(),
  });
  const actions = [];
  routes['GET /api/voice/readiness'] = () => json(readiness());
  routes['POST /api/settings/voice/asr-model'] = req => {
    const { action } = JSON.parse(req.body);
    actions.push(action);
    if (action === 'download') { model.state = 'downloading'; model.percent = 40; }
    if (action === 'cancel') { model.state = 'missing'; model.percent = 0; }
    return json({ ok: true, status: download() });
  };
  routes['GET /api/settings/voice'] = () => json({
    baseUrl: '', hasKey: false, model: '', whisperBaseUrl: '', hasWhisperKey: false, whisperModel: '', whisperLanguage: 'zh', whisperPrompt: '',
    qwenAudio: { hasApiKey: false, baseUrl: '', model: '', voice: '' },
    asr: {
      provider: 'auto', hasOpenaiKey: false, hasVolcAppId: false, hasVolcToken: false, funasrUrl: '',
      status: { local: { ready: model.state === 'ready', download: download() }, openai: { ready: false }, volcano: { ready: false }, funasr: { ready: false } },
    },
  });
  routes['/api/v1/voice-runtime'] = () => json({ ok: true, runtime: { state: 'not_installed', installed: false } });
  routes['/api/v1/voice-gateway'] = () => json({ ok: true, gateway: { enabled: false }, legacy: [] });
  routes['/api/v1/voice-gateway/runtime'] = () => json({ ok: true, runtime: { state: 'stopped' } });
  routes['/api/air'] = () => json({ ok: true, directories: [{ id: 'd1', name: 'MultiCC 主仓', path: '/projects/multicc' }], clis: ['codex'], migration: { errors: [] }, tasks: [], sessions: [] });
  routes['/api/cron'] = () => json([]);
  routes['/api/docs-registry'] = () => json([]);

  await withCdpHarness({ routes, screenshotDir: shots }, async page => {
    const label = (key, params) => page.evaluate(`t(${JSON.stringify(key)}${params ? ',' + JSON.stringify(params) : ''})`);
    const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
    const hidden = selector => page.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return !n || n.hidden || n.closest('[hidden]') !== null; })()`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });

    // ── ① 麦克风 ───────────────────────────────────────────────────────
    await page.navigate('/mic.html');
    assert.ok(await page.waitFor(`!!window.vc`), 'composer mounted');
    await page.evaluate(`document.getElementById('mic').click()`);
    assert.ok(await page.waitFor(`document.getElementById('mcc-voice-guide') && !document.getElementById('mcc-voice-guide').hidden`), '点麦克风直接弹引导卡');
    assert.equal(await text('#mcc-voice-guide [data-part="title"]'), await label('voiceGuideTitle'));
    assert.equal(await text('#mcc-voice-guide [data-part="local"]'), await label('voiceGuideDownload'));
    assert.equal(await text('#mcc-voice-guide [data-part="cloud"]'), await label('voiceGuideUseCloud'));
    assert.equal(await page.evaluate(`document.getElementById('mic').classList.contains('recording')`), false, '没开始录音');
    assert.equal(page.requests.some(r => r.path === '/api/voice/stt'), false, '没有白录一段再上传');
    await page.screenshot('01-mic-guide-missing');

    await page.evaluate(`document.querySelector('#mcc-voice-guide [data-part="local"]').click()`);
    assert.ok(await page.waitFor(`!document.querySelector('#mcc-voice-guide [data-part="bar"]').hidden`), '下载中出现进度条');
    assert.deepEqual(actions, ['download']);
    assert.equal(await text('#mcc-voice-guide [data-part="desc"]'), await label('voiceGuideDownloading'));
    assert.match(await text('#mcc-voice-guide [data-part="progress"]'), /^40% · /, '进度行从服务端数字来');
    assert.equal(await text('#mcc-voice-guide [data-part="local"]'), await label('airVoiceLocalCancel'));
    await page.screenshot('02-mic-guide-downloading');

    model.state = 'ready';
    model.percent = 100;
    const readyTitle = await label('voiceGuideReadyTitle');
    assert.ok(await page.waitFor(`document.querySelector('#mcc-voice-guide [data-part="title"]').textContent === ${JSON.stringify(readyTitle)}`, { timeoutMs: 6000 }),
      '轮询跟到「已就绪」');
    assert.equal(await text('#mcc-voice-guide [data-part="desc"]'), await label('voiceGuideReadyDesc'));
    assert.equal(await hidden('#mcc-voice-guide [data-part="bar"]'), true);
    await page.screenshot('03-mic-guide-ready');

    // ── ② Air 语音设置 ─────────────────────────────────────────────────
    model.state = 'missing';
    model.percent = 0;
    actions.length = 0;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate('/air?dir=d1&view=voice');
    assert.ok(await page.waitFor(`document.getElementById('air-voice-setup') && !document.getElementById('air-voice-setup').hidden`), '顶上挂了提示条');
    assert.equal(await text('#air-voice-setup-text'), await label('airVoiceSetupMissing'));
    assert.equal(await hidden('#air-voice-asr-body'), false, '没有可用识别时 ASR 那块自动展开到本地模型');
    await page.screenshot('04-settings-banner-missing');

    await page.evaluate(`document.getElementById('air-voice-setup-action').click()`);
    const cancelLabel = await label('airVoiceLocalCancel');
    assert.ok(await page.waitFor(`document.getElementById('asr-local-action').textContent === ${JSON.stringify(cancelLabel)}`), '下载开始，按钮变成取消');
    assert.ok(await page.waitFor(`document.getElementById('air-voice-setup-text').textContent === ${JSON.stringify(await label('airVoiceSetupDownloading'))}`), '提示条跟着说在下载');
    assert.deepEqual(actions, ['download']);
    await page.screenshot('05-settings-downloading');

    await page.evaluate(`document.getElementById('asr-local-action').click()`);
    assert.ok(await page.waitFor(`${JSON.stringify(actions)}.length >= 0 && document.getElementById('asr-local-action').textContent !== ${JSON.stringify(cancelLabel)}`), '取消后按钮回到下载');
    assert.deepEqual(actions, ['download', 'cancel'], '「取消下载」发的是 cancel');
  });
});
