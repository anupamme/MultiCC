(function (global) {
  'use strict';
  // "会话医生": one click asks a small tool-using model agent (server-side, no CLI
  // process involved) to diagnose this session. Shift/Alt-click also lets it fix
  // things inside the session's own worktree.
  const POLL_MS = 2000;
  const MAX_POLLS = 150;

  function formatReport(run) {
    const r = run.report || {};
    const lines = [`🩺 诊断${run.status === 'done' ? '完成' : '未完整结束'}：${r.summary || '无结论'}`, `根因：${r.rootCause || '未确认'}`];
    if (r.evidence && r.evidence.length) lines.push(`证据：\n- ${r.evidence.join('\n- ')}`);
    if (run.actions && run.actions.length) lines.push(`已执行的修复：\n- ${run.actions.map(a => `${a.kind}: ${a.detail}`).join('\n- ')}`);
    if (r.nextSteps && r.nextSteps.length) lines.push(`需要你处理：\n- ${r.nextSteps.join('\n- ')}`);
    if (!run.autofix && r.rootCause && !/未确认/.test(r.rootCause)) lines.push('提示：按住 Shift 点击「诊断」可让它在该会话 worktree 内自动修复。');
    return lines.join('\n');
  }

  function create(options) {
    const doc = options.document;
    const fetchImpl = options.fetch || global.fetch.bind(global);
    const sleep = options.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    let running = false;

    async function diagnose({ autofix = false } = {}) {
      const id = options.getSessionName();
      if (!id) { options.addSystemMsg('当前没有会话，无法诊断'); return { ok: false }; }
      if (running) return { ok: false, reason: 'running' };
      running = true;
      try {
        const res = await fetchImpl(options.withToken(`/api/sessions/${encodeURIComponent(id)}/doctor`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autofix }),
        });
        const started = await res.json().catch(() => ({}));
        if (!res.ok || !started.runId) {
          options.addSystemMsg(`🩺 诊断无法启动：${started.error || res.status}（需要先在辅助模型里配好可用的 Provider）`);
          return { ok: false };
        }
        options.addSystemMsg(`🩺 会话医生已开始${autofix ? '（含自动修复）' : '（只读）'}…`);
        let seen = 0;
        for (let i = 0; i < MAX_POLLS; i++) {
          await sleep(POLL_MS);
          const r = await fetchImpl(options.withToken(`/api/doctor/runs/${started.runId}`));
          const data = await r.json().catch(() => ({}));
          const run = data.run;
          if (!run) continue;
          const tools = run.events.filter(e => e.type === 'tool');
          if (tools.length > seen) {
            options.addSystemMsg(`🩺 ${tools.slice(seen).map(e => e.name).join(' → ')}`);
            seen = tools.length;
          }
          if (run.status !== 'running') {
            options.addSystemMsg(run.status === 'error' ? `🩺 诊断失败：${run.error}` : run.status === 'cancelled' ? '🩺 诊断已取消' : formatReport(run));
            return { ok: run.status === 'done', run };
          }
        }
        options.addSystemMsg('🩺 诊断超时，仍在后台运行，可稍后再点一次查看');
        return { ok: false, reason: 'timeout' };
      } catch (error) {
        options.addSystemMsg(`🩺 诊断失败：${error.message}`);
        return { ok: false };
      } finally { running = false; }
    }

    const btn = doc.getElementById('doctor-btn');
    if (btn) btn.addEventListener('click', event => {
      options.closeMoreMenu?.();
      diagnose({ autofix: !!(event.shiftKey || event.altKey) });
    });
    return Object.freeze({ diagnose });
  }

  const api = Object.freeze({ create, formatReport });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatDoctor = api;
}(typeof window !== 'undefined' ? window : globalThis));
