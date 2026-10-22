'use strict';

// Codex (ChatGPT) OAuth — multicc's own PKCE client, the sibling of
// claude-auth/official-oauth.js.
//
// Account login used to delegate to an interactive `codex login` terminal. The
// CLI binds 127.0.0.1:1455 for the redirect, so a browser that cannot reach
// that loopback (remote MultiCC, another machine, a profile that never opens)
// leaves the terminal waiting forever — there was no way to paste the callback
// back. Claude accounts never had that problem because multicc owns their
// flow. This module gives Codex the same ownership: the authorize URL is
// handed to the browser, the redirect lands on multicc's own listener when it
// can, and when it cannot the user pastes the address they ended on.
//
//   authorize:  https://auth.openai.com/oauth/authorize  (browser)
//   exchange:   POST https://auth.openai.com/oauth/token  (form-encoded)
//   callback:   http://127.0.0.1:1455/auth/callback?code=...&state=...
//
// The credential this produces is the CLI's own auth.json shape
// (auth_mode / OPENAI_API_KEY / tokens / last_refresh), so a home written here
// is indistinguishable from one `codex login` wrote — the relay and the
// per-account refresher keep reading it exactly as before.
//
// Protocol constants mirror codex-cli 0.163.0 (codex-rs/login): client id
// app_EMoamEEZ73f0CkXaXp7hrann, ports 1455 then 1457, the connectors scopes,
// id_token_add_organizations / codex_cli_simplified_flow / originator.

const crypto = require('node:crypto');
const http = require('node:http');

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_PATH = '/oauth/authorize';
const TOKEN_PATH = '/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CALLBACK_PATH = '/auth/callback';
// The registered redirect for the public Codex client: 1455, with 1457 as the
// CLI's own fallback when something else already holds the first port.
const CALLBACK_PORTS = [1455, 1457];
const CALLBACK_HOST = '127.0.0.1';
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const ORIGINATOR = 'codex_cli_rs';
const TOKEN_TIMEOUT_MS = 30000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const LOGIN_PAGE_OK = '<!doctype html><meta charset="utf-8"><title>multicc</title><body style="font-family:system-ui;padding:2em">✅ 登录完成，可以关闭本页，回到 multicc 查看账号。<br>Login complete — you can close this tab.</body>';
const LOGIN_PAGE_ERR = '<!doctype html><meta charset="utf-8"><title>multicc</title><body style="font-family:system-ui;padding:2em">❌ 登录失败，请回 multicc 重试。<br>Login failed — please retry from multicc.</body>';

class CodexOAuthError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'CodexOAuthError';
    this.status = status;
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function generatePkce() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function generateState() {
  return base64url(crypto.randomBytes(24));
}

function redirectUriForPort(port) {
  return `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;
}

function buildAuthorizeUrl({ state, codeChallenge, redirectUri, issuer = ISSUER } = {}) {
  if (!redirectUri) throw new CodexOAuthError('redirectUri is required (bind the listener first)');
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    state: String(state || ''),
    code_challenge: String(codeChallenge || ''),
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: ORIGINATOR,
  });
  return `${issuer}${AUTHORIZE_PATH}?${params.toString()}`;
}

// The JWT payload is data, never advice: only the handful of claims the
// credential and the UI need are lifted out.
function parseIdTokenClaims(idToken) {
  try {
    const payload = String(idToken || '').split('.')[1];
    if (!payload) return {};
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return {};
    const auth = claims['https://api.openai.com/auth'];
    return {
      email: typeof claims.email === 'string' ? claims.email : '',
      name: typeof claims.name === 'string' ? claims.name : '',
      auth: auth && typeof auth === 'object' ? auth : {},
    };
  } catch (_) {
    return {};
  }
}

// auth.json as codex-cli writes it after `codex login` (AuthDotJson).
function buildAuthFile(tokens, { now = () => Date.now() } = {}) {
  const idToken = String((tokens && tokens.id_token) || '');
  const accessToken = String((tokens && tokens.access_token) || '');
  const refreshToken = String((tokens && tokens.refresh_token) || '');
  if (!accessToken) throw new CodexOAuthError('token response missing access_token');
  if (!refreshToken) throw new CodexOAuthError('token response missing refresh_token');
  const { email, auth } = parseIdTokenClaims(idToken);
  const accountId = typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : '';
  return {
    email,
    accountId,
    auth: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: refreshToken,
        ...(accountId ? { account_id: accountId } : {}),
      },
      last_refresh: new Date(now()).toISOString(),
    },
  };
}

async function exchangeCode(fetchImpl, { code, codeVerifier, redirectUri, issuer = ISSUER } = {}) {
  if (!redirectUri) throw new CodexOAuthError('redirectUri is required');
  // Form-encoded, like the CLI (TokenEncoding::Form) — the JSON form the
  // Claude endpoint wants is not accepted here.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code || ''),
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: String(codeVerifier || ''),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${issuer}${TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (res.status !== 200) {
    throw new CodexOAuthError(`token endpoint HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new CodexOAuthError('token endpoint returned non-JSON', { status: res.status });
  }
  return buildAuthFile(json);
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

// Bind the first free registered port. The redirect_uri has to be known
// before the authorize URL is built, so the port is decided here, not by the
// caller.
function listenOnFirstFree(ports, host) {
  return new Promise((resolve, reject) => {
    const list = [...ports];
    const failures = [];
    const attempt = () => {
      const port = list.shift();
      if (port == null) {
        const busier = failures.map(f => `${f.port}: ${f.message}`).join('; ');
        reject(new CodexOAuthError(`codex 回调端口都被占用（${busier}）`));
        return;
      }
      const server = http.createServer();
      const onError = (error) => {
        server.removeListener('listening', onListening);
        try { server.close(); } catch (_) {}
        failures.push({ port, message: error.message });
        if (error && error.code === 'EADDRINUSE') { attempt(); return; }
        reject(new CodexOAuthError(`无法监听回调端口 ${port}: ${error.message}`));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        // The actual bound port: for 0 (tests, and any caller that lets the OS
        // pick) the requested value is not the one the redirect must name.
        const bound = server.address();
        resolve({ server, port: bound && bound.port ? bound.port : port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    attempt();
  });
}

// One-shot loopback listener for the OAuth redirect, plus the paste escape
// hatch. Same contract as the Claude one: single-use, closes on the first
// /auth/callback hit, timeout, or cancel().
async function openCallback({ ports = CALLBACK_PORTS, timeoutMs = LOGIN_TIMEOUT_MS, host = CALLBACK_HOST } = {}) {
  const { server, port } = await listenOnFirstFree(ports, host);
  let timer;
  let settled = false;
  let settleResolve;
  const promise = new Promise((resolve, reject) => {
    settleResolve = resolve;
    server.on('request', (req, res) => {
      let url;
      try {
        url = new URL(req.url || '/', `http://${host}`);
      } catch (_) {
        res.writeHead(400); res.end(); return;
      }
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { connection: 'close' }); res.end(); return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      if (error || !code) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        res.end(LOGIN_PAGE_ERR);
        finish(() => reject(new CodexOAuthError(`authorization failed: ${error || 'missing code'}`)));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      res.end(LOGIN_PAGE_OK);
      finish(() => resolve({ code, state }));
    });
    timer = setTimeout(() => {
      finish(() => reject(new CodexOAuthError('login timed out waiting for the browser callback')));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  // The promise is also the failure channel for callers that only await it.
  promise.catch(() => {});

  function finish(settle) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      server.close(() => settle());
      // A browser tab often leaves an idle keep-alive socket behind (Node keeps
      // them 5s), and close() waits on those — the sign-in would appear to take
      // seconds after the redirect already landed. Drop idle sockets only; the
      // in-flight callback response is not idle and still flushes.
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    } catch (_) {
      settle();
    }
  }

  // A browser on another machine ends at its own loopback and cannot reach
  // this listener. Pasting that final address finishes the sign-in exactly as
  // if it had. Only this login's own callback is accepted: the address is
  // parsed, never fetched.
  function submit(raw, { expectedState } = {}) {
    if (settled) throw new CodexOAuthError('this sign-in is over; start it again');
    const text = String(raw == null ? '' : raw).trim();
    if (!text) throw new CodexOAuthError('paste the address the browser ended on');

    let parsed;
    if (/^https?:\/\//i.test(text)) {
      let url;
      try { url = new URL(text); } catch (_) { throw new CodexOAuthError('that address is not a valid URL'); }
      if (!isLoopbackHost(url.hostname)) {
        throw new CodexOAuthError('that address is not a loopback callback for this sign-in');
      }
      const gotPort = url.port || (url.protocol === 'https:' ? '443' : '80');
      if (String(gotPort) !== String(port)) {
        throw new CodexOAuthError('that address is from a different sign-in (port mismatch)');
      }
      if (url.pathname !== CALLBACK_PATH) {
        throw new CodexOAuthError('that address is not a sign-in callback');
      }
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      if (!code) throw new CodexOAuthError('that callback address has no code');
      parsed = { code, state };
    } else {
      // Some pages show the raw `code#state` instead of a URL.
      const hash = text.indexOf('#');
      if (hash <= 0 || hash === text.length - 1 || /\s/.test(text)) {
        throw new CodexOAuthError('paste the whole callback address, or the code shown as code#state');
      }
      parsed = { code: text.slice(0, hash), state: text.slice(hash + 1) };
    }

    if (expectedState && !parsed.state) {
      throw new CodexOAuthError('that callback address has no state to verify');
    }
    if (expectedState && parsed.state !== expectedState) {
      throw new CodexOAuthError('state mismatch (possible CSRF) — login discarded');
    }
    finish(() => settleResolve(parsed));
  }

  return {
    port,
    redirectUri: redirectUriForPort(port),
    promise,
    submit,
    cancel: () => finish(() => {}),
  };
}

module.exports = {
  ISSUER,
  AUTHORIZE_PATH,
  TOKEN_PATH,
  CLIENT_ID,
  CALLBACK_PATH,
  CALLBACK_PORTS,
  CALLBACK_HOST,
  SCOPE,
  ORIGINATOR,
  LOGIN_TIMEOUT_MS,
  CodexOAuthError,
  generatePkce,
  generateState,
  redirectUriForPort,
  buildAuthorizeUrl,
  parseIdTokenClaims,
  buildAuthFile,
  exchangeCode,
  openCallback,
};
