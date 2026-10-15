'use strict';

// Per-account Claude credential reader with refresh-on-read — the cpr claude
// proxy's injected readOfficialCredential and the per-account quota route both
// go through here. Both inline refresh and the background CLI supervisor own
// these files, so EVERY read joins their account lock, including locally fresh
// tokens. A CLI rotation can revoke the old access token before its probe ends
// and the supervisor adopts the new credential.

const { refreshTokens, fetchProfile, ClaudeOAuthError, REFRESH_MIN_BACKOFF_MS } = require('./official-oauth');
const { isCliCopy } = require('../official-accounts');

const EXPIRY_MARGIN_MS = 5 * 60 * 1000; // 与官方 CLI 一样，提前五分钟检查续期

function createClaudeAccountCredentialService(options = {}) {
  const accounts = options.accounts;
  if (!accounts) throw new TypeError('[claude-account-credentials] accounts store is required');
  const fetchImpl = options.fetch || globalThis.fetch;
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const now = options.now || (() => Date.now());
  // Shared with the per-account CLI refresher (accounts-refresh.js): one
  // rotation per account at a time, or two holders spend one single-use token.
  const exclusive = typeof options.exclusive === 'function' ? options.exclusive : async (id, fn) => fn();
  const fresh = (expiresAt, margin = EXPIRY_MARGIN_MS) => expiresAt == null || expiresAt > now() + margin;

  const inflight = new Map();     // accountId -> Promise (singleflight)
  const blockedUntil = new Map(); // accountId -> epoch ms (Retry-After backoff)
  const stats = new Map();        // accountId -> {refreshCount, lastError, lastRefreshAt}

  function note(id, patch) {
    stats.set(id, { refreshCount: 0, lastError: null, lastRefreshAt: null, ...(stats.get(id) || {}), ...patch });
  }

  function readStored(id) {
    const data = accounts.readClaudeCredential(id);
    if (!data) return { ok: false, reason: 'credential_unreadable' };
    const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
    if (!accessToken) return { ok: false, reason: 'access_token_missing' };
    const expiresAt = data.expired ? Date.parse(data.expired) : null;
    return {
      ok: true,
      accessToken,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '',
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      cliCopy: isCliCopy(data.source),
    };
  }

  async function refresh(id, refreshToken) {
    const blocked = blockedUntil.get(id) || 0;
    if (blocked > now()) {
      return { ok: false, reason: `refresh temporarily blocked until ${new Date(blocked).toISOString()}` };
    }
    if (!refreshToken) return { ok: false, reason: 'refresh_token_missing' };
    try {
      const tokenData = await refreshTokens(fetchImpl, { refreshToken, now });
      // Advisory, matching CPA: profile fills identity the token response omitted.
      try {
        const profile = await fetchProfile(fetchImpl, tokenData.access_token);
        for (const key of ['email', 'account_uuid', 'organization_uuid', 'organization_name']) {
          if (profile[key]) tokenData[key] = profile[key];
        }
      } catch (error) {
        logger.warn('claude_account_profile_fetch_failed', { accountId: id, error: error.message });
      }
      accounts.writeClaudeCredential(id, tokenData);
      blockedUntil.delete(id);
      const prev = stats.get(id);
      note(id, { refreshCount: (prev ? prev.refreshCount : 0) + 1, lastError: null, lastRefreshAt: now() });
      return { ok: true, accessToken: tokenData.access_token, expiresAt: Date.parse(tokenData.expired) };
    } catch (error) {
      if (error instanceof ClaudeOAuthError && error.status === 429) {
        blockedUntil.set(id, now() + (error.retryAfterMs || REFRESH_MIN_BACKOFF_MS));
      }
      note(id, { lastError: error.message });
      logger.warn('claude_account_refresh_failed', { accountId: id, error: error.message, status: error.status || null });
      return { ok: false, reason: `refresh_failed: ${error.message}` };
    }
  }

  // A copy of the CLI's login shares the CLI's single-use refresh token:
  // rotating it would log the CLI out (or fail, the CLI having rotated first).
  // It is served until it lapses, then the account needs its own login.
  function refreshOwn(id, stored) {
    if (stored.cliCopy) return { ok: false, reason: 'cli_copy_needs_login' };
    return refresh(id, stored.refreshToken);
  }

  // The cpr-facing read: {token} on success, {token:null, reason} otherwise.
  // Sync-shape contract (cpr awaits the result, so async is fine).
  async function readAccountToken(id) {
    let pending = inflight.get(id);
    if (!pending) {
      pending = exclusive(id, () => {
        // 即使本地尚未过期，也必须等后台轮换结束后再读。
        const current = readStored(id);
        if (!current.ok) return { ok: false, reason: current.reason };
        if (fresh(current.expiresAt, current.cliCopy ? 60_000 : EXPIRY_MARGIN_MS)) {
          return { ok: true, accessToken: current.accessToken, expiresAt: current.expiresAt };
        }
        return refreshOwn(id, current);
      }).finally(() => inflight.delete(id));
      inflight.set(id, pending);
    }
    const refreshed = await pending;
    if (!refreshed.ok) return { token: null, reason: refreshed.reason };
    return { token: refreshed.accessToken };
  }

  async function recoverAccountToken(id, failedToken) {
    if (!failedToken) return { token: null, reason: 'failed_token_missing' };
    // 现有账号锁就是续期进行中标记：排在它后面，等保存完成后重读。
    // 异常恢复不再发起续期；没有新令牌就保留原错误，避免重复续期。
    return exclusive(id, () => {
      const current = readStored(id);
      if (!current.ok) return { token: null, reason: current.reason };
      if (current.accessToken !== failedToken && fresh(current.expiresAt)) {
        return { token: current.accessToken };
      }
      return { token: null, reason: 'credential_unchanged' };
    });
  }

  function status(id) {
    const blocked = blockedUntil.get(id) || 0;
    return {
      ...(stats.get(id) || { refreshCount: 0, lastError: null, lastRefreshAt: null }),
      blockedUntil: blocked > now() ? blocked : null,
    };
  }

  // The cpr claude-proxy entry point (createHandler options.readOfficialCredential):
  // an account context object resolves via refresh-on-read; anything else (the
  // canonical claude-official provider's legacy string arg) defers to the shared
  // Keychain reader. The default is required lazily so this module stays loadable
  // in tests without the router package.
  const sharedLoginReader = typeof options.sharedLoginReader === 'function'
    ? options.sharedLoginReader
    : (arg) => require('cli-provider-router').readOfficialOAuthToken(arg);

  function readOfficialCredential(arg) {
    if (arg && typeof arg === 'object') return readAccountToken(arg.accountId);
    return sharedLoginReader(arg);
  }

  function recoverOfficialCredential(arg, failedToken) {
    // 共享钥匙串登录仍由原生 CLI 管理，不能在此花它的刷新令牌。
    if (!arg || typeof arg !== 'object') return Promise.resolve({ token: null, reason: 'unmanaged_login' });
    return recoverAccountToken(arg.accountId, failedToken);
  }

  return Object.freeze({ readAccountToken, readOfficialCredential, recoverAccountToken, recoverOfficialCredential, status });
}

module.exports = { createClaudeAccountCredentialService, EXPIRY_MARGIN_MS };
