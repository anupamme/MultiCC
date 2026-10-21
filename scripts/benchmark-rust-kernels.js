#!/usr/bin/env node
'use strict';

// 确定性合成数据；结果逐字段相同才计时。必须加载真实 Rust，不允许回退。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const js = require('../src/task-board/search');
const rust = require('../src/native/task-search');
const runtime = require('../src/native/runtime');
const usage = require('../src/token-global');
const { taskBoard, usageFixture } = require('../tests/fixtures/rust-kernel-fixtures');

const rounds = 9;
const query = '全文检索 索引';
const clean = ({ generatedAt, ...data }) => data;
const rounded = n => Math.round(n * 1000) / 1000;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: rounded(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]) };
}
async function measure(fn) {
  await new Promise(resolve => setImmediate(resolve));
  const start = performance.now();
  let delay = 0, last = start;
  const timer = setInterval(() => {
    const now = performance.now(); delay = Math.max(delay, now - last); last = now;
  }, 1);
  try {
    await fn();
    const ms = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 1));
    return { ms, delay };
  } finally { clearInterval(timer); }
}
async function compare(node, native) {
  // 预热运行时与 OS 文件缓存；不宣称这是物理磁盘冷读。
  await node(); await native(); await native(); await node();
  const times = { node: [], rust: [] }, delays = { node: [], rust: [] };
  for (let i = 0; i < rounds; i++) {
    for (const [name, fn] of i % 2 ? [['rust', native], ['node', node]] : [['node', node], ['rust', native]]) {
      const sample = await measure(fn);
      times[name].push(sample.ms); delays[name].push(sample.delay);
    }
  }
  const result = { node: stats(times.node), rust: stats(times.rust),
    timerDelay: { node: stats(delays.node), rust: stats(delays.rust) } };
  result.speedup = rounded(result.node.medianMs / result.rust.medianMs);
  return result;
}
async function main() {
  runtime.getNative('search', 'rust');
  const before = runtime.status();
  const report = { environment: { date: new Date().toISOString(), platform: process.platform,
    arch: process.arch, os: os.release(), cpu: os.cpus()[0]?.model, node: process.version,
    rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim() },
    method: { rounds, warmupPerBackend: 2, order: '交错执行', data: '确定性合成数据',
      usageCache: 'OS 缓存预热；绕过两分钟应用缓存',
      timerDelay: '每次运行期间 1ms 心跳观测到的最大间隔（包括定时器精度）', query, limit: 10 }, search: [], usage: [] };
  for (const count of [100, 1000, 3000]) {
    const board = taskBoard(count), nodeIndex = js.buildTaskSearchIndex(board);
    const nativeIndex = await rust.buildIndex(board, { backend: 'rust' });
    assert.deepEqual(await rust.searchIndex(nativeIndex, query), js.searchTaskIndex(nodeIndex, query));
    const buildNative = [], queryNative = [];
    const full = await compare(() => js.searchBoard(board, query), async () => {
      const index = await rust.buildIndex(board, { backend: 'rust' });
      await rust.searchIndex(index, query);
      buildNative.push(index.timings.buildNativeMs); queryNative.push(index.timings.searchNativeMs);
    });
    const reused = await compare(() => js.searchTaskIndex(nodeIndex, query), () => rust.searchIndex(nativeIndex, query));
    const nodeBackend = rust.createTaskSearchBackend({ backend: 'node' });
    const rustBackend = rust.createTaskSearchBackend({ backend: 'rust' });
    assert.deepEqual(await rustBackend(board, query), nodeBackend(board, query));
    const cachedRoute = await compare(() => nodeBackend(board, query), () => rustBackend(board, query));
    report.search.push({ tasks: count, full, reused, cachedRoute,
      nativeInternal: { build: stats(buildNative.slice(2)), query: stats(queryNative.slice(2)) } });
    console.error(`任务搜索 ${count} 项：完整 ${full.speedup} 倍，复用索引 ${reused.speedup} 倍，含缓存校验 ${cachedRoute.speedup} 倍`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-benchmark-'));
  try {
    for (const rows of [200, 3000]) {
      const fixture = usageFixture(path.join(root, String(rows)), { files: 4, rows, contentBytes: 4096 });
      const telemetry = {}, nativeTimes = [];
      const native = async () => {
        const result = await usage._compute({ ...fixture, backend: 'rust', telemetry });
        nativeTimes.push(telemetry.nativeMs); return result;
      };
      assert.deepEqual(clean(await native()), clean(await usage._computeJs(fixture)));
      const scan = await compare(() => usage._computeJs(fixture), native);
      report.usage.push({ bytes: fixture.bytes, files: 8, rowsPerProviderFile: rows,
        scan, nativeInternal: stats(nativeTimes.slice(3)) });
      console.error(`Token 扫描 ${(fixture.bytes / 1048576).toFixed(1)} MiB：${scan.speedup} 倍`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const after = runtime.status();
  assert.equal(after.fallbacks, before.fallbacks, '对照不允许静默回退');
  report.nativeExecutions = { search: after.search - before.search, usage: after.usage - before.usage, fallbacks: 0 };
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
