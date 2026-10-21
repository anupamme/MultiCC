'use strict';

const fields = ['id', 'dirId', 'title', 'status', 'runState', 'goalState', 'updatedAt',
  'createdAt', 'sessionId', 'readOnly', 'resource', 'attention', 'worktreeChanges'];
const DAY = 86_400_000, NOW = 1_790_000_000_000;
function fixture(count, payloadBytes = 8192) {
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: `t${String(i).padStart(7, '0')}`, dirId: `d${i % 10}`,
    title: `任务 ${i} ${['数据库优化', '修复缓存', 'Rust 索引', '中文检索', '页面刷新'][i % 5]}`,
    status: i % 19 === 0 ? 'archived' : i % 13 === 0 ? 'done' : 'active',
    runState: ['idle', 'running', 'waiting', 'error', 'succeeded', 'queued', 'background'][i % 7],
    goalState: i % 2 ? 'achieved' : 'interact', updatedAt: NOW - (i % 3) * DAY + i,
    createdAt: NOW - 7 * DAY + i, sessionId: `s${i}`, readOnly: i % 11 === 0,
    resource: { id: `w${i}`, residency: i % 4 ? 'hibernated' : 'resident', pins: [] },
    attention: i % 17 === 0 ? { kind: 'waiting', at: NOW + i } : null,
    worktreeChanges: i % 31 === 0 ? { dirty: true, ahead: 1 } : null,
    refs: Array.from({ length: 4 }, (_, j) => ({ sessionId: `s${i}`, dirId: `d${i % 10}`, ts: NOW + i * 10 + j })),
    contextLedger: 'x'.repeat(payloadBytes),
  }));
  return { tasks, metadata: { directories: Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, name: `项目 ${i}` })),
    taskPins: tasks.slice(2, 5).map(t => t.id), taskTodos: tasks.filter((t, i) => i % 23 === 0).map(t => t.id),
    taskTodoIgnored: tasks.filter((t, i) => i % 29 === 0).map(t => t.id) } };
}
function project(source) {
  const card = Object.fromEntries(fields.map(key => [key, source[key]]));
  card.readOnly = !!source.readOnly;
  card.lastMessageAt = source.lastMessageAt || (source.refs || []).reduce((n, ref) => Math.max(n, ref.ts || 0), 0)
    || source.createdAt || source.updatedAt || 0;
  card.refCount = source.refCount ?? (source.refs || []).length;
  return card;
}

// 两种语言使用同一 SQL、同一库结构。摘要投影仍读取原始 JSON，不预建摘要表。
const fullSql = "SELECT body FROM shell_records WHERE kind = 'task' ORDER BY rowid";
const pairs = fields.flatMap(key => [`'${key}'`, `json_extract(body, '$.${key}')`]);
pairs.push("'lastMessageAt'", "COALESCE((SELECT max(json_extract(value, '$.ts')) FROM json_each(body, '$.refs')), json_extract(body, '$.createdAt'), 0)",
  "'refCount'", "json_array_length(body, '$.refs')");
const projectedSql = `SELECT json_object(${pairs.join(',')}) AS body FROM shell_records WHERE kind = 'task' ORDER BY rowid`;

module.exports = { fixture, project, fullSql, projectedSql, NOW, DAY };
