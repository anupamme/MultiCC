'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createBackend } = require('./backends');
const { fixture, project, fullSql, projectedSql, NOW, DAY } = require('./fixtures');
const { databaseConstructor } = require('../../src/sqlite/driver');
const { makeDatabase } = require('./database');

test('四种后端：卡片投影、全量与增量、所有筛选、分页、置顶、删除、元数据失效一致', async () => {
  const backends = ['current', 'incremental', 'worker', 'rust'].map(createBackend);
  const { tasks, metadata } = fixture(1277, 256); let checks = 0;
  const broadcast = cmd => Promise.all(backends.map(b => b.run(cmd)));
  async function compare(cmd) {
    const results = await broadcast(cmd); for (let i = 1; i < results.length; i++) assert.deepEqual(results[i], results[0], JSON.stringify(cmd)); checks++;
  }
  const filters = ['all', 'open', 'recent', 'archived', 'today', 'needs', 'waiting', 'waitingReply', 'todo', 'achieved', 'interact', 'running', 'error', 'succeeded'];
  async function audit() {
    for (const status of filters) for (const sort of ['latest', 'oldest', 'visit']) {
      await compare({ op: 'page', options: { status, sort, page: 2, limit: 17, dayStart: NOW - DAY,
        visits: { [tasks[8].id]: NOW, [tasks[5].id]: NOW + 1 } } });
    }
    for (const query of ['Rust', '中文', '项目 3', '不存在', '']) await compare({ op: 'page', options: { status: 'all', query, dirId: 'd3', limit: 50 } });
    await compare({ op: 'page', options: { status: 'all', ids: [tasks[3].id, tasks[4].id, tasks[1].id, tasks[8].id, 'missing'] } });
    await compare({ op: 'page', options: { status: 'all', page: 99999, limit: 1 } });
    await compare({ op: 'page', options: { status: 'all', ids: [] } });
    for (const dayStart of [0, NOW - DAY, NOW + DAY]) await compare({ op: 'stats', dayStart });
  }
  try {
    await broadcast({ op: 'apply', reset: true, tasks, metadata }); await audit();
    await broadcast({ op: 'apply', tasks, metadata }); await audit();
    tasks[4].title = '原地修改 中文😀'; tasks[4].runState = 'error'; tasks[4].dirId = 'd9';
    await broadcast({ op: 'apply', tasks: [tasks[4]], metadata }); await audit();
    metadata.taskPins.reverse(); metadata.taskTodos.push(tasks[4].id); metadata.taskTodoIgnored.push(tasks[2].id);
    await broadcast({ op: 'apply', tasks: [], metadata, removed: [tasks[5].id, tasks[6].id] }); await audit();
    const changed = tasks.slice(100, 400).map((t, i) => ({ ...t, runState: i % 2 ? 'done' : 'completed', updatedAt: NOW + 100, lastMessageAt: NOW }));
    await broadcast({ op: 'apply', tasks: changed, metadata }); await audit();
    await broadcast({ op: 'apply', reset: true, tasks: [], metadata }); await audit();
    console.log(`已完成 ${checks} 组逐字段对照，每组覆盖四种后端`);
  } finally { for (const b of backends) await b.close(); }
});

for (const indexed of [false, true]) test(`SQLite ${indexed ? '附加索引' : '原结构'}：全文读取、摘要投影、批量写入、失败回滚与重新打开一致`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-read-model-check-'));
  const { tasks, metadata } = fixture(80); const nodes = [];
  try {
    for (const kind of ['current', 'incremental', 'worker', 'rust']) {
      const file = path.join(dir, kind + '.sqlite'); makeDatabase(file, tasks, { indexed });
      const backend = createBackend(kind); nodes.push({ backend, file, kind }); await backend.run({ op: 'dbOpen', file });
    }
    const broadcast = cmd => Promise.all(nodes.map(({ backend }) => backend.run(cmd)));
    const compare = async cmd => { const r = await broadcast(cmd); for (const row of r.slice(1)) assert.deepEqual(row, r[0]); return r[0]; };
    await broadcast({ op: 'dbLoad', sql: fullSql, metadata });
    const original = await compare({ op: 'page', options: { status: 'all', limit: 50 } });
    await broadcast({ op: 'dbLoad', sql: projectedSql, metadata });
    assert.deepEqual(await compare({ op: 'page', options: { status: 'all', limit: 50 } }), original);
    const updates = tasks.slice(0, 20).map(t => ({ ...t, title: '写入后可见', updatedAt: NOW + DAY }));
    await compare({ op: 'dbWrite', tasks: updates });
    for (const entry of nodes) {
      const { backend, file, kind } = entry;
      const broken = [{ ...tasks[0], title: '不能提交' }, { ...tasks[1], id: null }];
      await assert.rejects(async () => backend.run({ op: 'dbWrite', tasks: broken }));
      await backend.close();
      // worker 关闭后需要新建；重新打开数据库验证持久化，而不是只读内存缓存。
      entry.backend = createBackend(kind);
      await entry.backend.run({ op: 'dbOpen', file });
      await entry.backend.run({ op: 'dbLoad', sql: projectedSql, metadata });
    }
    await compare({ op: 'page', options: { status: 'all', limit: 50 } });
    // 使用独立连接核验四个文件，避免把后端缓存误认为落盘成功。
    for (const { file } of nodes) {
      const db = new (databaseConstructor())(file);
      try {
        const body = JSON.parse(db.prepare("SELECT body FROM shell_records WHERE id=? AND kind='task'").get(tasks[0].id).body);
        assert.deepEqual(body, updates[0], '完整记录必须保留，不能在摘要化时丢失正文或上下文');
      }
      finally { db.close(); }
    }
  } finally {
    for (const { backend } of nodes) { try { await backend.close(); } catch (_) {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

