'use strict';

// GET /api/codex/quota — fetch Codex (ChatGPT) subscription usage directly from
// the official backend using the on-disk OAuth token. No CDP needed: the codex
// CLI stores its rotated credential at ~/.codex/auth.json, and the same
// chatgpt.com/backend-api/wham/usage endpoint the CLI's /status uses returns the
// plan's quota windows (Plus: 5h + weekly; prolite: weekly only), plan tier,
// per-feature limits, and credit balance.
//
// Failure modes surfaced to the frontend:
//   no_auth           — ~/.codex/auth.json missing / unreadable (not logged in)
//   unavailable       — API error / unexpected shape

const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderQuotaBar } = require('../quota/quota-bar-view');
const { codexRateLimitWindows } = require('../codex/rate-limit-windows');
const { officialFetch } = require('../network/official-fetch');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TIMEOUT_MS = 10000;

function readCodexAuth(authFile) {
  try {
    const file = authFile || path.join(os.homedir(), '.codex', 'auth.json');
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tokens = auth && auth.tokens;
    if (!tokens || !tokens.access_token) return null;
    return { accessToken: tokens.access_token, accountId: tokens.account_id || '' };
  } catch (_) {
    return null;
  }
}

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function windowResetsAt(w, nowMs) {
  let resetsAt = finite(w.reset_at);
  if (resetsAt === null) {
    const after = finite(w.reset_after_seconds);
    resetsAt = after !== null ? Math.trunc(nowMs / 1000) + after : null;
  }
  return resetsAt;
}

async function fetchCodexUsage(nowMs = Date.now(), options = {}) {
  // chatgpt.com is an official upstream: go through officialFetch so the
  // env / macOS system proxy applies (direct connects time out behind one).
  const fetchImpl = options.fetch || officialFetch;
  const auth = readCodexAuth(options.authFile);
  if (!auth) return { status: 'no_auth', error: options.authFile ? '该账号尚未完成登录' : '未找到 ~/.codex/auth.json，请先登录 codex' };

  let body;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-Id': auth.accountId,
        originator: 'codex_cli_rs',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      // e.g. {"error":{"code":"token_revoked"}} — the stored login is dead.
      let code = '';
      try { code = ((await res.json()).error || {}).code || ''; } catch (_) {}
      return { status: 'no_auth', error: `Codex 登录凭证已失效（HTTP ${res.status}${code ? ` ${code}` : ''}），请重新登录 codex` };
    }
    if (!res.ok) return { status: 'unavailable', error: `HTTP ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { status: 'unavailable', error: ctrl.signal.aborted ? `timeout after ${TIMEOUT_MS}ms` : (err.message || 'fetch failed') };
  } finally {
    clearTimeout(timer);
  }

  const rl = body && typeof body === 'object' ? body.rate_limit : null;
  if (!rl || typeof rl !== 'object') return { status: 'unavailable', error: 'rate_limit missing' };

  const windows = codexRateLimitWindows(rl, nowMs).map((w) => ({
    window: w.window,
    usedPercent: w.usedPercent,
    remainingPercent: Math.max(0, 100 - w.usedPercent),
    windowSeconds: w.windowSeconds,
    resetsAt: w.resetsAt,
  }));
  if (!windows.length) return { status: 'unavailable', error: 'no rate-limit window exposed' };
  const weekly = windows.find((w) => w.window === '1wk') || null;

  // Per-feature additional limits (e.g. GPT-5.3-Codex-Spark)
  const additional = Array.isArray(body.additional_rate_limits)
    ? body.additional_rate_limits
        .filter((a) => a && a.limit_name && a.rate_limit && a.rate_limit.primary_window)
        .map((a) => ({
          name: a.limit_name,
          usedPercent: finite(a.rate_limit.primary_window.used_percent) ?? 0,
          resetsAt: windowResetsAt(a.rate_limit.primary_window, nowMs),
        }))
    : [];

  return {
    status: 'ok',
    fetchedAt: nowMs,
    planType: typeof body.plan_type === 'string' ? body.plan_type : null,
    email: typeof body.email === 'string' ? body.email : null,
    limitReached: rl.limit_reached === true,
    // Every window, short → long (resetsAt in epoch seconds).
    windows,
    // The weekly window alone, kept for callers that predate `windows`.
    weekly: weekly
      ? { usedPercent: weekly.usedPercent, remainingPercent: weekly.remainingPercent, windowSeconds: weekly.windowSeconds, resetsAt: weekly.resetsAt }
      : null,
    additional,
    credits: body.credits && typeof body.credits === 'object'
      ? {
          hasCredits: body.credits.has_credits === true,
          balance: body.credits.balance ?? '0',
        }
      : null,
  };
}

function mountCodexQuotaRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') return;
  app.get('/api/codex/quota', async (req, res) => {
    try {
      // ?account=<officialAccountId> reads that account's own auth.json
      // (multi-account); absent → the shared ~/.codex login as before.
      const accountId = String(req.query && req.query.account || '').trim();
      let authFile = null;
      if (accountId) {
        if (typeof deps.resolveAccountAuthFile !== 'function') {
          return res.status(400).json({ status: 'unavailable', error: 'official accounts not enabled' });
        }
        authFile = deps.resolveAccountAuthFile(accountId);
        if (!authFile) return res.status(404).json({ status: 'no_auth', error: '账号不存在' });
      }
      const result = await fetchCodexUsage(undefined, authFile ? { authFile } : {});
      const status = result?.status || 'unavailable';
      const httpStatus = status === 'ok' ? 200 : status === 'no_auth' ? 401 : 500;
      // The bar is rendered here, once, so the web and the app display the same
      // string rather than each formatting this JSON their own way.
      res.status(httpStatus).json({ ...result, bar: renderQuotaBar('codex', result) });
    } catch (_) {
      const result = { status: 'unavailable', error: 'codex quota fetch failed' };
      res.status(500).json({ ...result, bar: renderQuotaBar('codex', result) });
    }
  });
}

module.exports = { mountCodexQuotaRoutes, fetchCodexUsage };
