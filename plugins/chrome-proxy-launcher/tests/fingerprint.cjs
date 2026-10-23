'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const binary = process.env.PLUGIN_TEST_BIN || path.resolve(__dirname, '../target/release/chrome-proxy-launcher');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-fingerprint-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  function run(command, input) {
    const r = spawnSync(binary, [command], { env: { ...process.env, HOME: home }, input: JSON.stringify(input), encoding: 'utf8', timeout: 15000 });
    assert.ifError(r.error);
    return JSON.parse(r.stdout);
  }
  function prepare(name) {
    const saved = run('save', { name, proxy: { scheme: 'http', host: '127.0.0.1', port: 1 } });
    assert.equal(saved.ok, true);
    const generated = run('fingerprint-prepare', { id: saved.data.profile.id });
    assert.equal(generated.ok, true);
    return { id: saved.data.profile.id, ...generated.data };
  }
  return { home, run, prepare };
}
test('扩展按身份生成且不包含凭据，重复生成复用配置，损坏配置不会被重置', t => {
  const f = fixture(t), a = f.prepare('one'), b = f.prepare('two');
  const script = fs.readFileSync(path.join(a.extensionPath, 'fingerprint.js'), 'utf8');
  assert.notEqual(script, fs.readFileSync(path.join(b.extensionPath, 'fingerprint.js'), 'utf8'));
  const again = f.run('fingerprint-prepare', { id: a.id });
  assert.equal(again.ok, true);
  assert.equal(again.data.installationVerified, false);
  assert.equal(script, fs.readFileSync(path.join(a.extensionPath, 'fingerprint.js'), 'utf8'));
  assert.doesNotMatch(script, /__MULTICC_FINGERPRINT_SEED__|proxyUrl|password|fetch\(/);
  const manifest = JSON.parse(fs.readFileSync(path.join(a.extensionPath, 'manifest.json')));
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.equal(manifest.permissions, undefined);
  const seed = path.join(a.extensionPath, '../identity.json');
  fs.writeFileSync(seed, 'broken');
  assert.equal(f.run('fingerprint-prepare', { id: a.id }).ok, false);
  assert.equal(fs.readFileSync(seed, 'utf8'), 'broken');
  assert.equal(f.run('fingerprint-prepare', { id: '../outside' }).ok, false);
  fs.unlinkSync(seed);
  assert.equal(f.run('fingerprint-prepare', { id: a.id }).ok, false, '已有扩展丢失种子时也不得自动换身份');
  assert.equal(f.run('remove', { id: a.id }).ok, true);
  const replacement = f.prepare('one');
  assert.notEqual(replacement.id, a.id, '尚未启动过浏览器的身份也不复用旧指纹目录');
});

// 调试管道仅用于全新临时浏览器的验收。产品既不开调试端口，也不加 unsafe 调试参数。
async function browser(t, dir) {
  const child = spawn(process.env.CHROME_TEST_BIN, [
    '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--proxy-server=http://127.0.0.1:1', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--user-data-dir=${dir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let id = 0, buffer = Buffer.alloc(0), exited = false;
  const pending = new Map();
  const done = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  const finish = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', finish);
  child.on('exit', () => finish(new Error('临时浏览器退出')));
  child.stdio[3].on('error', finish);
  child.stdio[4].on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(0)) >= 0) {
      const raw = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 1);
      if (!raw) continue;
      const message = JSON.parse(raw), p = pending.get(message.id);
      if (!p) continue;
      pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new Error(JSON.stringify(message.error)));
      else p.resolve(message.result);
    }
  });
  function call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP 超时: ${method}`)); }, 8000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id: requestId, method, params, sessionId }) + '\0');
    });
  }
  async function close() {
    if (exited) return;
    await call('Browser.close').catch(() => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await done; clearTimeout(timer);
  }
  t.after(close);
  await call('Browser.getVersion');
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Page.enable', {}, sessionId);
  return { call, close, sessionId, evaluate: async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    assert.equal(r.exceptionDetails, undefined, JSON.stringify(r.exceptionDetails));
    return r.result.value;
  } };
}

const page = `<!doctype html><script>
function hash(bytes) { let n=2166136261; for(const b of bytes)n=Math.imul(n^b,16777619);return n>>>0; }
function measure() {
 const c=document.createElement('canvas');c.width=64;c.height=64;const ctx=c.getContext('2d');
 ctx.fillStyle='rgb(80,120,160)';ctx.fillRect(0,0,64,64);
 const full=ctx.getImageData(0,0,64,64).data;
 const crop=ctx.getImageData(10,12,16,16).data;
 let cropMatches=true;for(let y=0;y<16;y++)for(let x=0;x<16;x++)for(let k=0;k<4;k++)if(crop[(y*16+x)*4+k]!==full[((y+12)*64+x+10)*4+k])cropMatches=false;
 const off=new OffscreenCanvas(64,64), raw=off.getContext('2d');raw.drawImage(c,0,0);
 const g=document.createElement('canvas');g.width=64;g.height=64;const gl=g.getContext('webgl',{preserveDrawingBuffer:true});
 let webgl=null;if(gl){gl.clearColor(.3,.5,.7,1);gl.clear(gl.COLOR_BUFFER_BIT);const bytes=new Uint8Array(64*64*4);gl.readPixels(0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,bytes);webgl=hash(bytes);}
 window.sampleCanvas=c;
 const g2=document.createElement('canvas');g2.width=64;g2.height=64;const gl2=g2.getContext('webgl2',{preserveDrawingBuffer:true});
 let webgl2=null;if(gl2){gl2.clearColor(.3,.5,.7,1);gl2.clear(gl2.COLOR_BUFFER_BIT);const bytes=new Uint8Array(64*64*4);gl2.readPixels(0,0,64,64,gl2.RGBA,gl2.UNSIGNED_BYTE,bytes);webgl2=hash(bytes);}
 return { pixels:hash(full), png:hash(new TextEncoder().encode(c.toDataURL())), raw:hash(raw.getImageData(0,0,64,64).data), cropMatches, webgl, webgl2 };
}
window.first=measure();window.framesSeen={};
addEventListener('message', e=>{if(e.data?.fingerprintTest)framesSeen[e.origin]=e.data.value;});
if(parent!==window)parent.postMessage({fingerprintTest:true,value:first},'*');
</script>`;
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
const closeServer = s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); });

test('原版 Chrome 扩展：首段脚本与 iframe 生效、重开稳定、身份不同、导出不改变绘图缓冲区', { skip: !process.env.CHROME_TEST_BIN, timeout: 90000 }, async t => {
  const f = fixture(t), a = f.prepare('one'), b = f.prepare('two');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(page); });
  await listen(server); t.after(() => closeServer(server));
  const other = http.createServer((req, res) => {
    if (req.url === '/pixel.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>'); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(page);
  });
  await listen(other); t.after(() => closeServer(other));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cross = `http://127.0.0.1:${other.address().port}`;
  let nav = 0;
  async function sample(br) {
    const url = `${origin}/?n=${++nav}`;
    await br.call('Page.navigate', { url }, br.sessionId);
    for (let i = 0; i < 100; i++) {
      const result = await br.evaluate(`location.href===${JSON.stringify(url)} && window.first`);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('测试页未加载');
  }
  const profileDir = path.join(f.home, 'chrome-one');
  let br = await browser(t, profileDir);
  const baseline = await sample(br);
  assert.equal(baseline.pixels, baseline.raw);
  assert.notEqual(baseline.webgl, null, '测试浏览器必须支持 WebGL');
  assert.notEqual(baseline.webgl2, null, '测试浏览器必须支持 WebGL2');
  await br.call('Extensions.loadUnpacked', { path: a.extensionPath });
  const protectedA = await sample(br);
  assert.notEqual(protectedA.pixels, baseline.pixels);
  assert.notEqual(protectedA.png, baseline.png);
  assert.notEqual(protectedA.webgl, baseline.webgl);
  assert.notEqual(protectedA.webgl2, baseline.webgl2);
  assert.equal(protectedA.raw, baseline.raw, '绘图缓冲区保持原样');
  assert.equal(protectedA.cropMatches, true, '局部读出与整体读出一致');
  assert.deepEqual(await br.evaluate('measure()'), protectedA, '重复读取不会累积噪声');
  assert.deepEqual(await sample(br), protectedA, '刷新后稳定');
  const blobPixels = await br.evaluate(`new Promise(resolve=>sampleCanvas.toBlob(async blob=>{const bmp=await createImageBitmap(blob);const c=new OffscreenCanvas(64,64),ctx=c.getContext('2d');ctx.drawImage(bmp,0,0);resolve(hash(ctx.getImageData(0,0,64,64).data));}))`);
  assert.equal(blobPixels, protectedA.pixels);
  const securityErrors = await br.evaluate(`new Promise((resolve,reject)=>{const img=new Image();img.onerror=reject;img.onload=()=>{const c=document.createElement('canvas'),ctx=c.getContext('2d');ctx.drawImage(img,0,0);const names=[];for(const fn of [()=>ctx.getImageData(0,0,1,1),()=>c.toDataURL(),()=>c.toBlob(()=>{})]){try{fn();names.push('未报错')}catch(e){names.push(e.name)}}resolve(names)};img.src=${JSON.stringify(cross + '/pixel.svg')};})`);
  assert.deepEqual(securityErrors, ['SecurityError', 'SecurityError', 'SecurityError'], '保持原生跨域画布安全检查');
  await br.evaluate(`[${JSON.stringify(origin)},${JSON.stringify(cross)}].forEach(url=>{const frame=document.createElement('iframe');frame.src=url+'/frame';document.body.append(frame);})`);
  let frames;
  for (let i=0;i<100;i++) { frames=await br.evaluate('framesSeen');if(frames[origin]&&frames[cross])break;await new Promise(r=>setTimeout(r,30)); }
  assert.deepEqual(frames[origin], protectedA);
  assert.notEqual(frames[cross]?.pixels, baseline.pixels, '跨域 iframe 也已注入');
  assert.ok(frames[cross]);
  await br.close();
  br = await browser(t, profileDir);
  // CDP 的 loadUnpacked 是临时加载；重启后再加载同一目录，验证持久化种子而非假称验证了人工安装状态。
  await br.call('Extensions.loadUnpacked', { path: a.extensionPath });
  assert.deepEqual(await sample(br), protectedA, '浏览器重开后加载同一扩展目录，指纹结果保持一致');
  await br.close();
  const second = await browser(t, path.join(f.home, 'chrome-two'));
  const { id: secondExtension } = await second.call('Extensions.loadUnpacked', { path: b.extensionPath });
  const protectedB = await sample(second);
  assert.notEqual(protectedB.pixels, protectedA.pixels);
  assert.notEqual(protectedB.webgl, protectedA.webgl);
  await second.call('Extensions.uninstall', { id: secondExtension });
  assert.deepEqual(await sample(second), baseline, '卸载并刷新后恢复原始行为');
  await second.close();
});
