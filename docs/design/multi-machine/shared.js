// 多电脑统一管理 · 原型共享的假数据和小工具。三套方案读同一份数据，方便横向对比。
'use strict';

const MACHINES = [
  { id: 'mbp', name: 'MacBook Pro', role: '本机', os: 'macOS 15', color: 'var(--m1)', online: true,
    power: '🔋 82%', lid: '开盖', cpu: 34, mem: 61, ver: 'v2.4.3', running: 1, waiting: 2, error: 3,
    screen: true, url: 'http://127.0.0.1:3000', lastSeen: '刚刚', clis: 'claude · codex · opencode' },
  { id: 'mini', name: 'Mac mini · 办公室', role: '', os: 'macOS 14', color: 'var(--m2)', online: true,
    power: '⚡ 接电', lid: '—', cpu: 72, mem: 78, ver: 'v2.4.3', running: 3, waiting: 1, error: 0,
    screen: true, url: 'https://office.example.com', lastSeen: '3 秒前', clis: 'claude · codex' },
  { id: 'win', name: 'Windows 台式机', role: '', os: 'Windows 11', color: 'var(--m3)', online: true,
    power: '⚡ 接电', lid: '—', cpu: 12, mem: 40, ver: 'v2.4.1', running: 0, waiting: 0, error: 1,
    screen: false, url: 'http://192.168.1.23:3000', lastSeen: '8 秒前', clis: 'claude', outdated: true },
  { id: 'nuc', name: 'Ubuntu 服务器', role: '', os: 'Ubuntu 24.04', color: 'var(--m4)', online: false,
    power: '⚡ 接电', lid: '—', cpu: 0, mem: 0, ver: 'v2.4.3', running: 0, waiting: 0, error: 0,
    screen: false, url: 'https://nuc.example.com', lastSeen: '2 小时前', clis: 'claude · codex' },
];

const DIRS = [
  { m: 'mbp', name: 'multicc', path: '~/Downloads/gapasea-all-in-one/code/claudecode/multicc', run: 1, total: 359 },
  { m: 'mbp', name: 'WeXin', path: '~/Downloads/WeXin', run: 0, total: 7 },
  { m: 'mbp', name: 'Mafit', path: '~/Downloads/Mafit', run: 0, total: 34 },
  { m: 'mini', name: 'marketing', path: '~/code/gapasea-marketing', run: 2, total: 58 },
  { m: 'mini', name: 'Shop', path: '~/OutdoorShop', run: 1, total: 4 },
  { m: 'mini', name: 'multicc', path: '~/code/multicc', run: 0, total: 41 },
  { m: 'win', name: 'AncientGods', path: 'D:\\code\\AncientGods', run: 0, total: 2 },
  { m: 'win', name: 'multicc-win-agent', path: 'D:\\code\\multicc', run: 0, total: 6 },
  { m: 'nuc', name: 'trader_hermes', path: '/srv/trader_hermes', run: 0, total: 2 },
];

const TASKS = [
  { m: 'mini', dir: 'marketing', title: '小红书千帆周报复盘', st: 'run', phase: '执行中 · 4 分钟', at: '09:58' },
  { m: 'mini', dir: 'marketing', title: 'TikTok GMV Max 补素材', st: 'run', phase: '执行中 · 12 分钟', at: '09:47' },
  { m: 'mbp', dir: 'multicc', title: '多电脑统一管理 · 三版交互设计', st: 'run', phase: '执行中', at: '09:57' },
  { m: 'mini', dir: 'Shop', title: '1688 货源比价', st: 'run', phase: '执行中 · 1 分钟', at: '09:56' },
  { m: 'mbp', dir: 'multicc', title: 'Air 首屏 CDN 阻塞排查', st: 'wait', phase: '等你回复', at: '09:31' },
  { m: 'mini', dir: 'marketing', title: '万相台人群包', st: 'wait', phase: '等你确认预算', at: '09:12' },
  { m: 'win', dir: 'multicc-win-agent', title: 'Windows agent 命名管道', st: 'err', phase: '执行出错 · dotnet 未安装', at: '昨天' },
  { m: 'mbp', dir: 'Mafit', title: '日线矩阵带回测', st: 'done', phase: '已完成', at: '08:40' },
  { m: 'nuc', dir: 'trader_hermes', title: '夜间行情抓取', st: 'off', phase: '电脑离线 · 上次 07:52', at: '07:52' },
];

const machine = id => MACHINES.find(m => m.id === id);
const dot = m => `<span class="mdot" style="background:${m.color}"></span>`;
const chip = id => { const m = machine(id); return `<span class="mchip">${dot(m)}${m.name}</span>`; };
const stLabel = { run: '<span class="st run">● 执行中</span>', wait: '<span class="st wait">◐ 等你回复</span>',
  err: '<span class="st err">✕ 异常</span>', done: '<span class="st run">✓ 完成</span>', off: '<span class="st off">○ 离线</span>' };

function toast(text) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = text; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 1800);
}
function openDialog(id) { document.getElementById(id).classList.add('show'); }
function closeDialog(id) { document.getElementById(id).classList.remove('show'); }
document.addEventListener('click', e => {
  if (e.target.classList && e.target.classList.contains('scrim')) e.target.classList.remove('show');
  document.querySelectorAll('.pop.show').forEach(p => { if (!p.contains(e.target) && !e.target.closest('[data-pop]')) p.classList.remove('show'); });
});
