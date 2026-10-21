'use strict';
const fs = require('node:fs');
const path = require('node:path');
const topics = ['历史消息 全文检索 索引 分词', '语音录制 播放 音频设备', '供应商账号 配额 模型路由',
  '任务调度 队列 恢复 幂等', '文件上传 图片预览 下载', '窗口布局 菜单 按钮 样式'];
function taskBoard(count) {
  const tasks = {};
  for (let i = 0; i < count; i += 1) {
    const topic = topics[i % topics.length];
    tasks[`tsk_${i}`] = { id: `tsk_${i}`, title: `${topic} ${i}`, dirId: `dir_${i % 4}`,
      status: i % 9 ? 'active' : 'archived', updatedAt: 1700000000000 + i,
      areas: ['backend', `module${i % 23}`], description: `实现并验证${topic}，处理错误与边界情况。`,
      refs: Array.from({ length: 8 }, (_, j) => ({ excerpt: `${topic}：记录实现步骤、相关文件 src/module-${i % 37}.js、检查结果和后续计划。版本 v${j}.${i % 9}。` })) };
  }
  return { revision: 1, tasks, modules: {} };
}
function usageFixture(root, { files = 4, rows = 1000, contentBytes = 2048 } = {}) {
  const projectsDir = path.join(root, 'claude');
  const codexDir = path.join(root, 'codex');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  let bytes = 0;
  const base = Date.parse('2026-07-19T04:00:00Z');
  const content = 'x'.repeat(contentBytes);
  const write = (dir, name, entries) => {
    const text = entries.join('\n') + '\n'; bytes += Buffer.byteLength(text);
    fs.writeFileSync(path.join(dir, name), text);
  };
  for (let f = 0; f < files; f += 1) {
    const entries = [];
    for (let i = 0; i < rows; i += 1) {
      const record = JSON.stringify({ timestamp: new Date(base + i * 1000).toISOString(), requestId: `req-${f}-${i}`,
        message: { id: `msg-${f}-${i}`, model: `claude-${i % 3}`, content,
          usage: { input_tokens: 100 + i % 31, output_tokens: 12, cache_creation_input_tokens: 5, cache_read_input_tokens: 80 } } });
      entries.push(record);
      if (i % 40 === 0) entries.push(record); // 重复事件不应再次计数
    }
    entries.push('{invalid');
    write(projectsDir, `${f}.jsonl`, entries);
  }
  for (let f = 0; f < files; f += 1) {
    const entries = [JSON.stringify({ type: 'session_meta', timestamp: new Date(base - 1000).toISOString(), payload: { id: `codex-${f}` } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test' } })];
    for (let i = 0; i < rows; i += 1) {
      entries.push(JSON.stringify({ type: 'event_msg', timestamp: new Date(base + i * 1000).toISOString(), payload: { type: 'token_count',
        info: { total_token_usage: { input_tokens: (i + 1) * 100, cached_input_tokens: (i + 1) * 40, output_tokens: (i + 1) * 10 } } } }));
      // 真实扫描必须跳过无关、体积较大的工具内容。
      entries.push(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: content } }));
    }
    write(codexDir, `${f}.jsonl`, entries);
  }
  return { projectsDir, codexDir, now: new Date('2026-07-19T12:00:00Z'), bytes };
}
module.exports = { taskBoard, usageFixture };
