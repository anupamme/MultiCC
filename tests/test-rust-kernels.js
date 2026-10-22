'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const js = require('../src/task-board/search');
const native = require('../src/native/runtime');
const { buildIndex, searchIndex, createTaskSearchBackend } = require('../src/native/task-search');
const usage = require('../src/token-global');
const { taskBoard, usageFixture } = require('./fixtures/rust-kernel-fixtures');
const available = !!native.getNative('search', process.env.MULTICC_REQUIRE_RUST_TESTS === '1' ? 'rust' : 'auto');
const rustTest = (name, fn) => test(name, { skip: !available && '未构建可选 Rust 模块' }, fn);
const stableUsage = ({ generatedAt, ...data }) => data;

test('Node 模式不依赖原生模块，保持同步搜索接口', () => {
  const board = taskBoard(8);
  assert.deepEqual(createTaskSearchBackend({ backend: 'node' })(board, '全文检索'), js.searchBoard(board, '全文检索'));
});
test('原生模块缺失时自动回退，强制 Rust 时明确失败', () => {
  const script = `const r=require('./src/native/runtime'); if(r.getNative('search','auto')!==null)process.exit(1);try{r.getNative('search','rust');process.exit(2)}catch(e){if(e.message!=='rust_backend_unavailable')process.exit(3)}`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MULTICC_RUST_ADDON: path.join(os.tmpdir(), 'nonexistent-multicc-rust-module.node') }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
rustTest('搜索差分：中文、Unicode、空查询、过滤、排名、高亮完全一致', async () => {
  const board = taskBoard(150);
  const samples = ['😀 ＡＩＲ.js 全文检索', 'İSTANBUL ΣΟΣ Straße', 'é e\u0301 \u00a0全文检索\uFEFF',
    'ヿ 㐀䶿 한글 空格', 'a +b ..air provider-router 缓存', '全文检索 '.repeat(100)];
  for (let i = 0; i < samples.length; i += 1) board.tasks[`extra_${i}`] = {
    id: `extra_${i}`, title: samples[i], description: samples[(i + 1) % samples.length], updatedAt: 5,
    refs: [{ excerpt: '😀'.repeat(50) + samples[i] }], areas: [samples[i]], status: 'active',
  };
  board.tasks.tsk_2.mergedInto = 'tsk_1'; board.tasks.tsk_3.deleting = true; board.deletedTaskIds = ['tsk_4'];
  for (const statuses of [null, ['active'], ['archived']]) {
    const opts = { statuses };
    const index = await buildIndex(board, { ...opts, backend: 'rust' });
    assert.equal(index.backend, 'rust');
    const baseline = js.buildTaskSearchIndex(board, opts);
    for (const query of ['', 'a', '，。', '索', '全文检索', 'AIR.js', 'İSTANBUL', 'ΣΟΣ', '缓存 供应商', '😀全文检索', ...samples]) {
      for (const filters of [{}, { dirIds: ['dir_1', 'dir_2'] }, { taskIds: [] },
        { limit: 3, excludeTaskIds: ['tsk_0'], minScore: 2 }, { dirId: 'missing' }]) {
        assert.deepEqual(await searchIndex(index, query, { ...opts, ...filters }), js.searchTaskIndex(baseline, query, { ...opts, ...filters }), query);
      }
    }
  }
});
rustTest('随机搜索样本和同分排序保持一致', async () => {
  let seed = 17;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const vocabulary = ['任务', '缓存', '全文检索', 'air.js', 'provider-router', '索', 'ＡＢＣ', '😀', 'a', '한글'];
  for (let pass = 0; pass < 6; pass += 1) {
    const board = { tasks: {} };
    for (let i = 0; i < 70; i += 1) {
      const text = Array.from({ length: next() % 30 }, () => vocabulary[next() % vocabulary.length]).join(' ');
      const id = `${i % 2 ? 'a' : 'A'}-${i}`;
      board.tasks[id] = { id, title: text, description: text, updatedAt: i % 3 };
    }
    const index = await buildIndex(board, { backend: 'rust' });
    const baseline = js.buildTaskSearchIndex(board);
    for (const query of vocabulary) assert.deepEqual(await searchIndex(index, query), js.searchTaskIndex(baseline, query));
  }
});
rustTest('缓存按内容失效，同一对象和同一 revision 的修改也可见', async () => {
  const board = taskBoard(20);
  const backend = createTaskSearchBackend({ backend: 'rust' });
  assert.deepEqual(await backend(board, '全文检索'), js.searchBoard(board, '全文检索'));
  board.tasks.tsk_0.title = '改变标题后仍有全文检索';
  board.tasks.tsk_0.updatedAt += 1;
  board.deletedTaskIds = ['tsk_6'];
  assert.deepEqual(await backend(board, '全文检索'), js.searchBoard(board, '全文检索'));
  assert.deepEqual(await backend(board, '全文检索', { statuses: ['archived'] }), js.searchBoard(board, '全文检索', { statuses: ['archived'] }));
});
rustTest('HTTP 搜索等待原生结果，并将异步失败转换为 503', async () => {
  const { createTaskSearchRoutes } = require('../src/routes/task-search');
  const board = taskBoard(10);
  const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { this.body = b; return this; } });
  const res = response();
  await createTaskSearchRoutes({ getBoard: () => board, searchTasks: createTaskSearchBackend({ backend: 'rust' }) }).handleSearch({ query: { q: '全文检索' } }, res);
  assert.deepEqual(res.body.results, js.searchBoard(board, '全文检索', { limit: 20 }));
  const failed = response();
  await createTaskSearchRoutes({ getBoard: () => board, searchTasks: () => Promise.reject(new Error('failure')) }).handleSearch({ query: { q: '全文检索' } }, failed);
  assert.equal(failed.statusCode, 503);
});
rustTest('Token 文件扫描差分：重复、损坏尾行、无关正文与窗口一致', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-test-'));
  try {
    const fixture = usageFixture(root, { rows: 120 });
    const before = native.status().usage;
    assert.deepEqual(stableUsage(await usage._compute({ ...fixture, backend: 'rust' })), stableUsage(await usage._computeJs(fixture)));
    assert.equal(native.status().usage, before + 1, '必须确实经过 Rust，不能静默回退');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
rustTest('原生工作不阻塞 Node 定时器', async () => {
  const board = taskBoard(3000);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try { await buildIndex(board, { backend: 'rust' }); } finally { clearInterval(timer); }
  assert.ok(ticks > 0);
});

rustTest('不完整 Unicode 安全回退到 Node，保持历史字符串行为', async () => {
  const board = taskBoard(2);
  board.tasks.tsk_0.title = '\ud800全文检索\udfff';
  const before = native.status().fallbacks;
  assert.deepEqual(await createTaskSearchBackend({ backend: 'auto' })(board, '全文检索'), js.searchBoard(board, '全文检索'));
  assert.equal(native.status().fallbacks, before + 1);
});

rustTest('Token 不完整 Unicode 与非 ISO 时间回退，不能静默漏算', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-edge-'));
  try {
    const fixture = usageFixture(root, { files: 1, rows: 2 });
    for (const overrides of [{ requestId: '\ud800' }, { timestamp: 'July 19, 2026 12:00:00' },
      { timestamp: '2016-12-31T23:59:60Z' }, { timestamp: '0026-01-01T00:00:00Z' }]) {
      const row = { timestamp: '2026-07-19T01:00:00Z', requestId: 'extra',
        message: { id: 'extra', model: 'edge', usage: { input_tokens: 9 } }, ...overrides };
      fs.writeFileSync(path.join(fixture.projectsDir, 'edge.jsonl'), JSON.stringify(row) + '\n');
      const before = native.status().fallbacks;
      assert.deepEqual(stableUsage(await usage._compute({ ...fixture, backend: 'auto' })), stableUsage(await usage._computeJs(fixture)));
      assert.equal(native.status().fallbacks, before + 1);
      await assert.rejects(usage._compute({ ...fixture, backend: 'rust' }));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

rustTest('Token 日期窗口在 UTC、上海和纽约时区与 Node 一致', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-tz-'));
  try {
    const timestamps = ['2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z',
      '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z', '2026-11-01',
      '2026-11-01T01:30:00', '2026-10-31T23:59:59.999-04:00', 1793520000000];
    fs.writeFileSync(path.join(root, 'tz.jsonl'), timestamps.map((timestamp, i) => JSON.stringify({
      timestamp, requestId: String(i), message: { id: String(i), model: 'tz', usage: { input_tokens: i + 1 } },
    })).join('\n'));
    const script = `const u=require('./src/token-global'),a=require('node:assert/strict');
      const clean=({generatedAt,...v})=>v;(async()=>{const o={projectsDir:process.argv[1],codexDir:process.argv[1]+'/absent',now:new Date('2026-11-01T17:00:00Z')};
      a.deepEqual(clean(await u._compute({...o,backend:'rust'})),clean(await u._computeJs(o)));})().catch(e=>{console.error(e);process.exitCode=1})`;
    for (const TZ of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      const result = spawnSync(process.execPath, ['-e', script, root], { cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8', env: { ...process.env, TZ } });
      assert.equal(result.status, 0, `${TZ}: ${result.stderr}`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('打包明确要求 Rust 时缺产物必须失败；架构映射拒绝未知目标', () => {
  const { targetFor } = require('../scripts/build-rust-kernels');
  assert.equal(targetFor('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.throws(() => targetFor('unknown', 'arm64'));
  const script = `require('./scripts/stage-rust-kernels').stageRustKernels({repoRoot:'.',out:process.argv[1]})`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-package-'));
  try {
    const result = spawnSync(process.execPath, ['-e', script, root], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, MULTICC_REQUIRE_RUST_BUNDLE: '1', MULTICC_RUST_PREBUILT_DIR: path.join(root, 'absent') } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /打包缺少 Rust 模块/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

rustTest('打包后的 Rust 模块可加载，错误架构不能进入安装包', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-rust-package-'));
  const beforeDir = process.env.MULTICC_RUST_PREBUILT_DIR;
  const { stageRustKernels } = require('../scripts/stage-rust-kernels');
  try {
    process.env.MULTICC_RUST_PREBUILT_DIR = path.join(root, 'prebuilt');
    const source = process.env.MULTICC_RUST_ADDON || path.join(beforeDir || path.resolve(__dirname, '../native/prebuilt'), `${process.platform}-${process.arch}/multicc_core.node`);
    for (const arch of [process.arch, 'ia32']) {
      const dir = path.join(process.env.MULTICC_RUST_PREBUILT_DIR, `${process.platform}-${arch}`);
      fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(source, path.join(dir, 'multicc_core.node'));
    }
    const options = { repoRoot: '.', out: path.join(root, 'app-server'), logger: { log() {} } };
    const staged = stageRustKernels(options);
    // Windows keeps loaded DLLs locked until process exit. Probe in a child so
    // cleanup tests the package, without trying to unlink our own loaded module.
    const probe = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const addon = require(process.argv[1]);
      assert.equal(addon.protocolVersion(), 1);
      (async () => {
        const index = await addon.buildSearchIndex('[]');
        assert.deepEqual(JSON.parse((await index.search('{"terms":[],"strong":[],"phrase":""}')).result), []);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, staged], { encoding: 'utf8', timeout: 15000 });
    assert.equal(probe.status, 0, probe.stderr);
    assert.throws(() => stageRustKernels({ ...options, npmEnv: { npm_config_arch: 'ia32' } }), /架构不匹配/);
  } finally {
    if (beforeDir === undefined) delete process.env.MULTICC_RUST_PREBUILT_DIR; else process.env.MULTICC_RUST_PREBUILT_DIR = beforeDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
