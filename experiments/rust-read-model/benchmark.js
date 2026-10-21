#!/usr/bin/env node
'use strict';

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync, execFileSync } = require('node:child_process');
const { createBackend } = require('./backends');
const { fixture, project, fullSql, projectedSql, NOW, DAY } = require('./fixtures');
const { makeDatabase } = require('./database');
const { databaseConstructor } = require('../../src/sqlite/driver');
const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const rounds = Number(arg('--rounds', 15));
const round = n => +n.toFixed(4);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: round(sorted[Math.floor(sorted.length / 2)]), p95: round(sorted[Math.ceil(sorted.length * .95) - 1]), max: round(sorted.at(-1)) };
}
async function measure(fn) {
  await new Promise(resolve => setImmediate(resolve));
  let last = performance.now(), largestGap = 0;
  const timer = setInterval(() => { const now = performance.now(); largestGap = Math.max(largestGap, now - last); last = now; }, 1);
  const cpuStart = process.cpuUsage(), start = performance.now();
  try {
    await fn();
    const ms = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    await delay(2);
    return { ms, cpuMs: (cpu.user + cpu.system) / 1000, gapMs: largestGap };
  } finally { clearInterval(timer); }
}
async function child(kind, count) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-model-bench-'));
  const { tasks, metadata } = fixture(count);
  const cards = tasks.map(project);
  const file = path.join(directory, 'fixture.sqlite'); makeDatabase(file, tasks, { indexed: process.argv.includes('--sqlite-index') });
  const result = { kind, count, sourceBytes: Buffer.byteLength(JSON.stringify(tasks)), cardBytes: Buffer.byteLength(JSON.stringify(cards)), cases: {} };
  const probe = new (databaseConstructor())(file);
  try { result.nodeQueryPlan = probe.prepare('EXPLAIN QUERY PLAN ' + fullSql).all().map(r => r.detail); }
  finally { probe.close(); }
  global.gc?.();
  const baseline = process.memoryUsage(), backend = createBackend(kind), run = cmd => backend.run(cmd);
  let sequence = 0;
  const reset = () => run({ op: 'apply', reset: true, cards: true, tasks: cards, metadata });
  const query = () => run({ op: 'page', options: { status: 'all', limit: 20 } });
  const one = () => ({ ...cards[7], title: `增量更新 ${++sequence}`, runState: sequence % 2 ? 'running' : 'error', lastMessageAt: NOW + 1_000_000 + sequence });
  const batch = (n, full = false) => (full ? tasks : cards).slice(0, n).map((t, i) => ({ ...t, title: `批量 ${++sequence}`, updatedAt: NOW + DAY + sequence + i }));
  try {
    result.sqlite = (await run({ op: 'dbOpen', file })).sqlite;
    await reset(); await query(); await run({ op: 'gc' }); global.gc?.();
    result.memory = { baselineRssMiB: round(baseline.rss / 1048576), loadedRssMiB: round(process.memoryUsage().rss / 1048576),
      loadedJsHeapMiB: round(process.memoryUsage().heapUsed / 1048576) };
    const cases = {
      fullSourceBuild: () => run({ op: 'apply', reset: true, tasks, metadata }),
      compactBuild: () => run({ op: 'apply', reset: true, cards: true, tasks: tasks.map(project), metadata }),
      unchangedSnapshot: () => run({ op: 'apply', cards: true, tasks: cards, metadata }),
      cachedPage: query,
      uncachedPage: () => run({ op: 'page', options: { status: 'all', limit: 20, visits: { nonce: ++sequence } } }),
      singleUpdate: () => run({ op: 'apply', cards: true, tasks: [one()], metadata }),
      singleUpdateAndRead: async () => {
        await run({ op: 'apply', cards: true, tasks: [one()], metadata }); await query();
        await run({ op: 'stats', dayStart: NOW - DAY });
      },
      batch100AndRead: async () => {
        await run({ op: 'apply', cards: true, tasks: batch(100), metadata }); await query();
        await run({ op: 'stats', dayStart: NOW - DAY });
      },
      dbFullLoad: () => run({ op: 'dbLoad', sql: fullSql, metadata }),
      dbProjectedLoad: () => run({ op: 'dbLoad', sql: projectedSql, metadata }),
      dbWriteOne: () => run({ op: 'dbWrite', tasks: batch(1, true) }),
      dbWrite100: () => run({ op: 'dbWrite', tasks: batch(100, true) }),
    };
    for (const [name, fn] of Object.entries(cases)) {
      if (arg('--cases') && !arg('--cases').split(',').includes(name)) continue;
      await reset(); await query();
      await fn(); await fn(); global.gc?.();
      const samples = [];
      for (let i = 0; i < rounds; i++) samples.push(await measure(fn));
      result.cases[name] = { elapsedMs: summary(samples.map(s => s.ms)), cpuMs: summary(samples.map(s => s.cpuMs)),
        heartbeatMaxGapMs: summary(samples.map(s => s.gapMs)) };
      global.gc?.();
    }
    result.memory.peakRssMiB = round(process.resourceUsage().maxRSS / 1024);
    result.memory.finalRssMiB = round(process.memoryUsage().rss / 1048576);
    console.log(JSON.stringify(result));
  } finally { await backend.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

async function main() {
  if (process.argv.includes('--child')) return child(arg('--child'), Number(arg('--count')));
  const sizes = arg('--sizes', '1277,3000,10000').split(',').map(Number);
  const report = { environment: { at: new Date().toISOString(), cpu: os.cpus()[0].model, platform: process.platform,
    arch: process.arch, os: os.release(), node: process.version,
    rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
    method: { sizes, rounds, warmup: 2, payloadBytesPerTask: 8192, fixture: '确定性合成数据，无生产数据',
      sqliteExtraIndex: process.argv.includes('--sqlite-index'), cases: arg('--cases', '全部'),
      process: '每种后端和数据规模独立子进程，依次执行；不同规模轮换后端顺序',
      timing: '端到端，包含主线程 JSON 编码、桥接、排队、工作线程计算、结果解码；compactBuild 另包含 Node 摘要投影',
      memory: '整个隔离进程 RSS（含 fixture、Node、Rust/worker、SQLite）；不是 Rust 堆大小，peak 覆盖全部场景',
      sqlite: '同结构同SQL，WAL+NORMAL，操作系统缓存预热；不代表断电耐久性或实际业务完整事务',
      heartbeat: '1ms定时器在每次操作中的最大间隔；包含定时器抖动与调度延迟',
      scope: '卡片摘要、排序、计数、缓存、SQLite模拟读写；不实现权限决策、Git状态、WS游标重放、迁移和生产故障恢复' }, results: [] };
  const kinds = ['current', 'incremental', 'worker', 'rust'];
  for (let j = 0; j < sizes.length; j++) {
    for (const kind of [...kinds.slice(j % 4), ...kinds.slice(0, j % 4)]) {
      console.error(`开始模拟：${kind}，${sizes[j]} 条任务`);
      const run = spawnSync(process.execPath, ['--expose-gc', __filename, '--child', kind, '--count', String(sizes[j]), '--rounds', String(rounds),
        ...(process.argv.includes('--sqlite-index') ? ['--sqlite-index'] : []), ...(arg('--cases') ? ['--cases', arg('--cases')] : [])],
        { encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
      if (run.error || run.status !== 0) throw new Error(run.error?.message || run.stderr || '模拟进程失败');
      const result = JSON.parse(run.stdout); report.results.push(result);
      console.error(`完成模拟：${kind}，${sizes[j]} 条，${Object.entries(result.cases).map(([k,v])=>`${k} ${v.elapsedMs.median}ms`).join('；')}`);
    }
  }
  const output = arg('--out');
  if (output) { fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(`模拟数据已保存：${output}`); }
  else console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
