'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {execFile,spawnSync}=require('node:child_process');
const binary=process.env.PLUGIN_TEST_BIN||path.resolve(__dirname,'../target/release/chrome-proxy-launcher');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
const close=s=>new Promise(r=>{s.closeAllConnections();s.close(r)});
test('生产启动入口自动加载、重开指纹和会话 Cookie 保持、断代理不直连', {skip:!process.env.CHROME_TEST_BIN,timeout:90000},async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'multicc-auto-'));
 const run=(cmd,input)=>new Promise((resolve,reject)=>{const c=execFile(binary,[cmd],{env:{...process.env,HOME:home},timeout:45000},(e,out)=>{try{resolve(JSON.parse(out))}catch(_){reject(e||new Error(out))}});c.stdin.end(JSON.stringify(input));});
 let id; t.after(async()=>{if(id)await run('stop',{id});fs.rmSync(home,{recursive:true,force:true});});
 const chromeWrapper=path.join(home,'chrome');
 fs.writeFileSync(chromeWrapper, '#!/bin/sh\nexec '+"'"+process.env.CHROME_TEST_BIN.replaceAll("'", "'\\''")+"'"+' --use-mock-keychain --disable-background-networking "$@"\n',{mode:0o700});
 const samples=[];let hits=0;
 const target=http.createServer((req,res)=>{
  hits++;
  if(req.url.startsWith('/sample')){samples.push(JSON.parse(decodeURIComponent(req.url.split('?')[1])));res.end('ok');return;}
  res.setHeader('Content-Type','text/html');
  res.end(`<script>const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.fillStyle='rgb(80,120,160)';x.fillRect(0,0,64,64);const b=x.getImageData(0,0,64,64).data;let h=2166136261;for(const v of b)h=Math.imul(h^v,16777619);const old=document.cookie;document.cookie='session_test=yes;path=/';fetch('/sample?'+encodeURIComponent(JSON.stringify({hash:h>>>0,cookie:old})));setTimeout(()=>location.reload(),2000);</script>`);
 });await listen(target);t.after(()=>close(target));
 const origin=`http://127.0.0.1:${target.address().port}`;
 const proxy=http.createServer((req,res)=>{if(!req.url.startsWith(origin+'/')){res.writeHead(502);res.end();return;}http.get(req.url,{headers:{cookie:req.headers.cookie||''}},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res)}).on('error',()=>res.end());});
 proxy.on('connect',(_,s)=>{s.on('error',()=>{});s.end('HTTP/1.1 502 Bad Gateway\r\n\r\n',()=>s.destroy());});await listen(proxy);t.after(()=>close(proxy));
 const saved=await run('save',{name:'automatic',chromePath:chromeWrapper,proxy:{scheme:'http',host:'127.0.0.1',port:proxy.address().port}});assert.equal(saved.ok,true);id=saved.data.profile.id;
 async function sample(){for(let i=0;i<150;i++){if(samples.length)return samples.shift();await delay(50)}throw new Error('网页没有回传首段脚本样本，hits='+hits);}
 const first=await run('launch',{id,url:origin+'/',checkProxy:false});assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.data.fingerprint.installationVerified,true);
 const command=spawnSync('ps',['-p',String(first.data.pid),'-o','command='],{encoding:'utf8'}).stdout;
 assert.match(command,/--remote-debugging-pipe/);assert.doesNotMatch(command,/--remote-debugging-port/);
 assert.equal(fs.existsSync(path.join(first.data.userDataDir,'DevToolsActivePort')),false);
 process.kill(first.data.supervisorPid,0); // 一次性 launch 请求已退出，监督进程仍存活。
 const a=await sample();let raw=2166136261;for(let i=0;i<4096;i++)for(const b of [80,120,160,255])raw=Math.imul(raw^b,16777619);assert.notEqual(a.hash,raw>>>0,'首段脚本必须已受保护');
 const stopped=await run('stop',{id});assert.equal(stopped.ok,true,JSON.stringify(stopped));samples.length=0;
 for(let i=0;i<30;i++){try{process.kill(first.data.supervisorPid,0);await delay(50)}catch(_){break}}
 assert.throws(()=>process.kill(first.data.supervisorPid,0),{code:'ESRCH'});
 const second=await run('launch',{id,url:origin+'/',checkProxy:false});assert.equal(second.ok,true,JSON.stringify(second));
 const b=await sample();assert.equal(a.hash,b.hash);assert.match(b.cookie,/session_test=yes/,'会话 Cookie 必须跨重开保留');
 await close(proxy);await delay(500);const before=hits;await delay(2500);assert.equal(hits,before,'断开代理后不得直连测试站');
});


test('不支持自动加载或配置损坏时明确失败，不伪报加载成功', t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'multicc-auto-fail-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const run=(command,input)=>{
  const r=spawnSync(binary,[command],{env:{...process.env,HOME:home},input:JSON.stringify(input),encoding:'utf8',timeout:5000});
  assert.ifError(r.error);return JSON.parse(r.stdout);
 };
 const saved=run('save',{name:'unsupported',chromePath:'/usr/bin/true',proxy:{scheme:'http',host:'127.0.0.1',port:1}});
 const id=saved.data.profile.id;
 const rejected=run('launch',{id,checkProxy:false});assert.equal(rejected.ok,false);assert.match(rejected.error,/浏览器|管道/);
 const root=path.join(home,'.multicc/plugins-data/chrome-proxy-launcher');
 assert.equal(fs.existsSync(path.join(root,'run',id+'.pid')),false);
 const identity=path.join(root,'fingerprints',id,'identity.json');fs.writeFileSync(identity,'damaged');
 const damaged=run('launch',{id,checkProxy:false});assert.equal(damaged.ok,false);assert.match(damaged.error,/配置损坏/);
 assert.equal(fs.readFileSync(identity,'utf8'),'damaged');
 const injected=run('launch',{id,checkProxy:false,url:'--remote-debugging-port=9222'});
 assert.equal(injected.ok,false);assert.match(injected.error,/不能是启动参数/);
});
