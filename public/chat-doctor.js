(function (global) {
  'use strict';
  // "会话医生": one click asks a small tool-using model agent (server-side, no CLI
  // process involved) to diagnose this session. Shift/Alt-click also lets it fix
  // things inside the session's own worktree. offer() puts the same action next
  // to an abnormal output (error line, upstream-error bar) so it is one tap away
  // exactly when the session misbehaves.
  const POLL_MS = 2000;
  const MAX_POLLS = 150;

  function formatReport(run, translate) {
    const tr = translate || (key => key);
    const r = run.report || {};
    const head = tr(run.status === 'done' ? 'doctorReportDone' : 'doctorReportIncomplete', { summary: r.summary || tr('doctorNoConclusion') });
    const lines = [head, tr('doctorRootCause', { cause: r.rootCause || tr('doctorUnconfirmed') })];
    if (r.evidence && r.evidence.length) lines.push(`${tr('doctorEvidence')}\n- ${r.evidence.join('\n- ')}`);
    if (run.actions && run.actions.length) lines.push(`${tr('doctorActions')}\n- ${run.actions.map(a => `${a.kind}: ${a.detail}`).join('\n- ')}`);
    if (r.nextSteps && r.nextSteps.length) lines.push(`${tr('doctorNextSteps')}\n- ${r.nextSteps.join('\n- ')}`);
    if (!run.autofix && r.rootCause && !/未确认|unconfirmed/i.test(r.rootCause)) lines.push(tr('doctorFixHint'));
    return lines.join('\n');
  }

  function create(options) {
    const doc = options.document;
    const tr = options.translate || (key => key);
    const fetchImpl = options.fetch || global.fetch.bind(global);
    const sleep = options.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    let running = false;

    async function diagnose({ autofix = false } = {}) {
      const id = options.getSessionName();
      if (!id) { options.addSystemMsg(tr('doctorNoSession')); return { ok: false }; }
      if (running) return { ok: false, reason: 'running' };
      running = true;
      try {
        const res = await fetchImpl(options.withToken(`/api/sessions/${encodeURIComponent(id)}/doctor`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autofix }),
        });
        const started = await res.json().catch(() => ({}));
        if (!res.ok || !started.runId) {
          options.addSystemMsg(tr('doctorStartFailed', { error: started.error || res.status }));
          return { ok: false };
        }
        options.addSystemMsg(tr(autofix ? 'doctorStartedFix' : 'doctorStarted'));
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
            options.addSystemMsg(run.status === 'error' ? tr('doctorFailed', { error: run.error })
              : run.status === 'cancelled' ? tr('doctorCancelled') : formatReport(run, tr));
            return { ok: run.status === 'done', run };
          }
        }
        options.addSystemMsg(tr('doctorTimeout'));
        return { ok: false, reason: 'timeout' };
      } catch (error) {
        options.addSystemMsg(tr('doctorFailed', { error: error.message }));
        return { ok: false };
      } finally { running = false; }
    }

    const onClick = event => {
      options.closeMoreMenu?.();
      return diagnose({ autofix: !!(event.shiftKey || event.altKey) });
    };
    const btn = doc.getElementById('doctor-btn');
    if (btn) btn.addEventListener('click', onClick);

    // Attach a one-tap "diagnose" button to an abnormal-output element.
    function offer(el) {
      if (!el || typeof el.appendChild !== 'function' || el.querySelector?.('.doctor-offer')) return null;
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'doctor-offer';
      button.textContent = tr('doctorOffer');
      button.title = tr('doctorOfferTitle');
      button.style.cssText = 'margin-left:8px;padding:2px 10px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer';
      button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); onClick(event); });
      el.appendChild(button);
      return button;
    }

    return Object.freeze({ diagnose, offer });
  }

  const api = Object.freeze({ create, formatReport });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MultiCCChatDoctor = api;
}(typeof window !== 'undefined' ? window : globalThis));
