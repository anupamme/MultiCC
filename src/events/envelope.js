'use strict';

// Fixed event envelope: what a hook hands to the next action. Rule authors
// never define variables - they only write the instruction. Pure, no I/O.
//
//   sessionId, event, goal, goalState, conclusion, summary, error, taskId, ts
//
// `conclusion` = the last assistant reply of the source session (clipped and
// redacted). The next session can read the full history by `sessionId`.

const os = require('os');

const CONCLUSION_MAX = 2000;
const SUMMARY_MAX = 400;

// Events that carry a conclusion; running/restarted/trigger.* never do.
const CONCLUSION_EVENTS = Object.freeze(new Set([
  'task.finished', 'task.goal_resolved', 'task.achieved', 'task.needs_interaction',
  'task.waiting_user', 'task.waiting_background', 'task.failed',
]));

const SECRET_TEXT = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{8,})/gi;

function redactText(text) {
  let out = String(text == null ? '' : text).replace(SECRET_TEXT, (m, _a, prefix) => (prefix ? `${prefix}***` : '***'));
  const home = os.homedir();
  if (home && home !== '/') out = out.split(home).join('~');
  return out;
}

function clipText(text, max) {
  const value = redactText(text).trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text).join('\n');
  }
  return '';
}

// history: array of chat messages in order. Returns the last non-empty assistant reply.
function conclusionFromHistory(history) {
  if (!Array.isArray(history)) return '';
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message && message.role === 'assistant') {
      const text = messageText(message).trim();
      if (text) return clipText(text, CONCLUSION_MAX);
    }
  }
  return '';
}

function summaryOf(state) {
  return clipText(state && state.lastSummary || '', SUMMARY_MAX);
}

const GOAL_STATE_LABEL = Object.freeze({ achieved: '达成目标', interact: '需要交互' });

// The text injected into the next session. The user's instruction goes last.
function renderInjection(event, instruction) {
  const data = event.data || {};
  const lines = [`【multicc 自动触发】事件 ${event.type}`];
  lines.push(`来源会话：${event.sessionId || '（无）'}　任务：${data.goal || '（未命名）'}`);
  if (data.goalState) lines.push(`目标状态：${GOAL_STATE_LABEL[data.goalState] || data.goalState}`);
  if (data.errorCategory) lines.push(`错误类别：${data.errorCategory}${data.cancelled ? '（用户主动停止）' : ''}`);
  if (data.summary) lines.push(`任务摘要：${data.summary}`);
  if (data.conclusion) lines.push(`上一轮结论（已截断，完整内容请用来源会话 id 读取历史）：\n${data.conclusion}`);
  lines.push('');
  lines.push(`你的指令：${(instruction || '').trim() || '请根据以上信息简短汇报，并给出下一步建议。'}`);
  return lines.join('\n');
}

module.exports = {
  CONCLUSION_MAX, SUMMARY_MAX, CONCLUSION_EVENTS,
  redactText, clipText, conclusionFromHistory, summaryOf, renderInjection,
};
