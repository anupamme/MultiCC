'use strict';

const { redact, redactProviderRouteCapability } = require('../observability');

const TOOL_LABELS = Object.freeze({
  commandExecution: '正在执行命令', mcpToolCall: '正在调用工具',
  fileChange: '正在修改文件', webSearch: '正在搜索资料',
});
const END_STATES = Object.freeze({
  completed: 'completed', errored: 'failed', failed: 'failed',
  interrupted: 'interrupted', shutdown: 'interrupted', notFound: 'interrupted',
});

function safeText(value, limit = 180) {
  return String(redact(redactProviderRouteCapability(String(value || ''))))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, limit);
}

// 将属于当前会话树的原生事件转成后台展示事件，不转发子线程原始输出。
function createCodexBackgroundEvents({ emit, attach, mainThreadId = null, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, throttleMs = 1000 } = {}) {
  const agents = new Map();
  const tools = new Map();
  const activities = new Set();
  let mainId = mainThreadId;
  let sequence = 0;
  let disposed = false;
  const known = id => id === mainId || agents.has(id);
  const taskId = id => `codex-agent:${id}`;
  const activeCount = () => [...agents.values()].filter(a => a.live).length;
  function publish(subtype, id, description, status, kind = 'agent', extra = {}) {
    if (disposed) return;
    emit({ type: 'system', subtype: `codex_task_${subtype}`, task_id: id,
      description: safeText(description), status, kind, active: activeCount(), ...extra });
  }
  function progress(agent, text, force = false) {
    if (!agent?.live) return;
    const description = `${agent.label} · ${safeText(text)}`;
    const at = now();
    agent.lastActivityAt = at;
    if (!force && at - agent.lastPublishedAt < throttleMs) {
      agent.pendingText = text;
      if (!agent.progressTimer) {
        agent.progressTimer = setTimer(() => {
          agent.progressTimer = null;
          progress(agent, agent.pendingText);
        }, throttleMs - (at - agent.lastPublishedAt));
        agent.progressTimer?.unref?.();
      }
      return;
    }
    if (!force && description === agent.lastDescription && at - agent.lastPublishedAt < 30_000) return;
    clearTimer(agent.progressTimer);
    agent.progressTimer = null;
    agent.lastDescription = description;
    agent.lastPublishedAt = at;
    publish('progress', taskId(agent.id), description, 'running');
  }
  function start(agent) {
    agent.live = true;
    agent.ended = false;
    agent.lastPublishedAt = -Infinity;
    agent.lastDescription = `${agent.label} · 正在执行`;
    publish('started', taskId(agent.id), `${agent.label} · 正在执行`, 'running');
    const pulse = () => {
      if (disposed || !agent.live) return;
      publish('progress', taskId(agent.id), agent.lastDescription, 'running', 'agent', { heartbeat: true });
      agent.pulseTimer = setTimer(pulse, 30_000);
      agent.pulseTimer?.unref?.();
    };
    clearTimer(agent.pulseTimer);
    clearTimer(agent.progressTimer);
    agent.progressTimer = null;
    agent.pulseTimer = setTimer(pulse, 30_000);
    agent.pulseTimer?.unref?.();
  }
  function finish(agent, status) {
    if (!agent?.live || !END_STATES[status]) return;
    agent.live = false;
    agent.ended = true;
    clearTimer(agent.attachTimer);
    clearTimer(agent.pulseTimer);
    clearTimer(agent.progressTimer);
    agent.progressTimer = null;
    const normalized = END_STATES[status];
    const label = normalized === 'completed' ? '已完成' : normalized === 'failed' ? '执行失败' : '已中断';
    publish('done', taskId(agent.id), `${agent.label} · ${label}`, normalized);
  }
  function discover(id, parent, description = '', restart = false) {
    if (!id || id === mainId || !known(parent)) return null;
    let agent = agents.get(id);
    if (!agent) {
      const title = safeText(description, 60);
      agent = { id, parent, label: `子任务 ${++sequence}${title ? `：${title}` : ''}`,
        seen: false, live: false, ended: false, lastActivityAt: now() };
      agents.set(id, agent);
      start(agent);
      // 自动收到子线程事件时无需重复接入；否则只读接入正在运行的原生线程。
      agent.attachTimer = setTimer(() => {
        if (disposed || !agent.live || agent.seen || !attach) return;
        Promise.resolve().then(() => attach(id)).then(result => {
          const latest = result?.latestTurn;
          // 接入前已经结束的快速任务可能没有实时完成通知；只接受明确的最新终态。
          if (result?.thread?.status?.type === 'idle' && latest &&
              (!agent.activeTurnId || agent.activeTurnId === latest.id)) finish(agent, latest.status);
        }).catch(() => {
          progress(agent, '详细进度暂时不可用，等待子任务状态', true);
        });
      }, 100);
      agent.attachTimer?.unref?.();
    } else if (restart && agent.ended) start(agent);
    return agent;
  }
  function finishTool(id, status = 'completed') {
    const tool = tools.get(id);
    if (!tool) return;
    tools.delete(id);
    publish('done', tool.taskId, `${tool.label} · ${status === 'completed' ? '已完成' : status === 'failed' ? '执行失败' : '已中断'}`,
      END_STATES[status] || 'interrupted', 'tool');
  }
  function consume(message) {
    const method = message?.method;
    const params = message?.params || {};
    const thread = params.thread || {};
    const id = params.threadId || (method === 'thread/started' ? thread.id : null);
    const item = params.item || {};
    if (method === 'thread/started' && thread.parentThreadId) {
      discover(thread.id, thread.parentThreadId, thread.name || thread.agentNickname);
    }
    if (id && !known(id)) return { child: true, unrelated: true };
    const child = !!id && agents.has(id);
    const agent = child ? agents.get(id) : null;
    if (agent) { agent.seen = true; agent.lastActivityAt = now(); }

    if ((method === 'item/started' || method === 'item/completed') && item.type === 'collabAgentToolCall') {
      const parent = item.senderThreadId || id || mainId;
      if (known(parent)) {
        const restart = ['resumeAgent', 'followupTask', 'sendInput'].includes(item.tool);
        for (const receiver of item.receiverThreadIds || []) {
          if (item.tool !== 'spawnAgent' && !agents.has(receiver)) continue;
          if (item.tool === 'spawnAgent' && item.status !== 'completed') continue;
          discover(receiver, parent, item.prompt, restart);
        }
        for (const [receiver, state] of Object.entries(item.agentsStates || {})) {
          const target = agents.get(receiver);
          if (!target) continue;
          if (END_STATES[state?.status]) finish(target, state.status);
          else if (state?.status === 'running' || state?.status === 'pendingInit') progress(target, '正在执行');
        }
      }
    }
    if ((method === 'item/started' || method === 'item/completed') && item.type === 'subAgentActivity') {
      const key = item.id ? `${id}:${item.id}:${item.kind}` : null;
      if (!key || !activities.has(key)) {
        if (key) activities.add(key);
        const target = discover(item.agentThreadId, id || mainId, item.agentPath, item.kind === 'started');
        if (item.kind === 'completed' || item.kind === 'interrupted') finish(target, item.kind);
      }
    }
    let toolLabel = TOOL_LABELS[item.type];
    if (item.type === 'commandExecution' && /\b(test|pytest|jest|vitest)\b/.test(item.command || '')) toolLabel = '正在运行测试';
    if (item.type === 'mcpToolCall' && item.tool) toolLabel += `：${safeText(item.tool, 60)}`;
    if (method === 'item/started' && toolLabel) {
      if (agent) progress(agent, toolLabel, true);
      else if (id === mainId && item.id) {
        const key = `${id}:${item.id}`;
        if (!tools.has(key)) {
          const label = `本轮工具 · ${toolLabel}`;
          const tool = { taskId: `codex-tool:${key}`, label, lastPublishedAt: -Infinity };
          tools.set(key, tool);
          publish('started', tool.taskId, label, 'running', 'tool');
        }
      }
    }
    if (method === 'item/mcpToolCall/progress') {
      const text = safeText(params.message) || '工具仍在执行';
      if (agent) progress(agent, text);
      else {
        const tool = tools.get(`${id}:${params.itemId}`);
        if (tool && now() - tool.lastPublishedAt >= throttleMs) {
          tool.lastPublishedAt = now();
          publish('progress', tool.taskId, `${tool.label} · ${text}`, 'running', 'tool');
        }
      }
    }
    if (agent && /outputDelta$/.test(method || '')) {
      progress(agent, '工具仍在执行');
    }
    if (method === 'item/completed' && toolLabel) {
      if (agent) progress(agent, item.status === 'failed' ? '工具执行失败，等待子任务结果' : '工具执行结束', true);
      else finishTool(`${id}:${item.id}`, item.status === 'failed' || item.error ||
        (item.exitCode != null && Number(item.exitCode) !== 0) ? 'failed' :
        item.status === 'completed' ? 'completed' : 'interrupted');
    }
    if (method === 'turn/started' && agent) {
      agent.activeTurnId = params.turn?.id;
      if (agent.ended) start(agent);
    }
    if (method === 'turn/completed') {
      if (agent) finish(agent, params.turn?.status);
      else if (id === mainId || !id) {
        for (const key of [...tools.keys()]) finishTool(key, 'interrupted');
      }
    }
    if (agent && (method === 'thread/closed' || params.status?.type === 'systemError')) finish(agent, 'interrupted');
    return { child };
  }
  return {
    consume, activeCount, setMainThread(id) { mainId = id; },
    dispose() {
      disposed = true;
      for (const a of agents.values()) {
        clearTimer(a.attachTimer); clearTimer(a.pulseTimer); clearTimer(a.progressTimer);
      }
      agents.clear(); tools.clear();
    },
  };
}

module.exports = { createCodexBackgroundEvents, safeText };
