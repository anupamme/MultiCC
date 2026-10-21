'use strict';

// ── Persisted chat errors ────────────────────────────────────────────────────
//
// A turn's failure (provider 4xx/5xx, a Codex stream error, a lost message…) is
// broadcast as `{ type: 'error' }` and drawn as a live system line, but nothing
// wrote it to the transcript — so after a reload or a reopened session there was
// no trace of what had gone wrong. This writes the same line into chat history
// as a system message, keyed by a clientMsgId that the live broadcast carries as
// `errorClientMsgId`, so the page that watched it live and a page that replays
// history agree on one line instead of drawing it twice.

const crypto = require('node:crypto');

const DEDUPE_WINDOW_MS = 10_000;
const MAX_TEXT = 4000;

// Same predicate as public/chat-event-controller.js: a transient Codex reconnect
// is not shown live, so it must not appear in history either.
function isRecoverableReconnect(text) {
  const value = String(text || '').trim();
  const prefix = /^(?:Codex|Codex Exp|Codex Exec) 出错：Reconnecting\.\.\.\s*\d+\/\d+/i;
  if (!prefix.test(value)) return false;
  if (/^(?:Codex|Codex Exp|Codex Exec) 出错：Reconnecting\.\.\.\s*\d+\/\d+\s*$/i.test(value)) return true;
  return /\(.*(?:stream disconnected before completion|response\.completed).*\)\s*$/i.test(value);
}

function createErrorPersister({ appendChatMessage, now = Date.now, windowMs = DEDUPE_WINDOW_MS }) {
  const recent = new Map(); // `${sessionId}\n${text}` → { at, clientMsgId }

  // Returns the payload to broadcast: the original one, or a copy that carries
  // `errorClientMsgId` once the error is durably in history.
  function annotate(sessionId, payload) {
    if (!sessionId || payload?.type !== 'error' || typeof appendChatMessage !== 'function') return payload;
    const text = String(payload.error ?? '').trim().slice(0, MAX_TEXT);
    if (!text || isRecoverableReconnect(text)) return payload;
    try {
      const at = now();
      for (const [key, entry] of recent) if (at - entry.at > windowMs) recent.delete(key);
      const key = `${sessionId}\n${text}`;
      const seen = recent.get(key);
      if (seen) return { ...payload, errorClientMsgId: seen.clientMsgId };
      const clientMsgId = `err-${crypto.createHash('sha1').update(`${key}\n${at}`).digest('hex').slice(0, 16)}`;
      const saved = appendChatMessage(sessionId, {
        role: 'system',
        content: `Error: ${text}`,
        ts: at,
        clientMsgId,
        errorEvent: true,
        errorCode: typeof payload.code === 'string' ? payload.code : undefined,
      });
      if (!saved) return payload;
      recent.set(key, { at, clientMsgId });
      return { ...payload, errorClientMsgId: clientMsgId };
    } catch (_) {
      return payload; // persistence must never break the live broadcast
    }
  }

  return { annotate };
}

module.exports = { createErrorPersister, isRecoverableReconnect };
