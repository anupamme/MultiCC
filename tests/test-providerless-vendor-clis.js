'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const providers = require('../src/providers/core');

test('vendor-auth CLIs stay providerless while pool-capable CLIs resolve MultiCC provider pools', () => {
  assert.equal(providers.appTypeForCli('claude'), 'claude');
  assert.equal(providers.appTypeForCli('opencode'), 'claude');
  assert.equal(providers.appTypeForCli('codex'), 'codex');
  assert.equal(providers.appTypeForCli('qoder'), null);
  assert.equal(providers.appTypeForCli('kimi'), null);
  assert.equal(providers.appTypeForCli('codebuddy'), null);
  // DSH speaks Anthropic Messages over DEEPSEEK_BASE_URL, so it joins the
  // claude-side pool (probe-verified 2026-10-15).
  assert.equal(providers.appTypeForCli('dsh'), 'claude');
  // gemini still rides its own vendor account with no MultiCC pool.
  assert.equal(providers.appTypeForCli('gemini'), null);
  // Grok resolves globally by provider id (both messages/responses backends).
  assert.equal(providers.appTypeForCli('grok'), null);
  assert.equal(providers.appTypeForCli('zcode'), null);
  assert.deepEqual(providers.appTypesForCli('qoder'), []);
  assert.deepEqual(providers.appTypesForCli('codebuddy'), []);
  assert.deepEqual(providers.appTypesForCli('dsh'), ['claude']);
  assert.deepEqual(providers.appTypesForCli('gemini'), []);
  assert.deepEqual(providers.appTypesForCli('grok'), ['claude', 'codex']);
  assert.deepEqual(providers.appTypesForCli('zcode'), ['claude', 'codex']);
});

test('stale vendor provider ids cannot silently fall through to another account', () => {
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'qoder', provider: 'stale-provider' }), {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
  });
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'codebuddy', provider: 'stale-provider' }), {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
  });
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'gemini', provider: 'stale-provider' }), {
    env: {},
    skipDefaultModel: false,
    aliasOnly: false,
    providerModel: null,
    providerModels: [],
    providerName: null,
  });
  // Pool-capable CLIs fail closed on a stale binding instead of silently
  // degrading to the vendor's own account.
  assert.throws(
    () => providers.resolveSpawnEnv({ cli: 'dsh', provider: 'stale-provider' }),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
  assert.throws(
    () => providers.resolveSpawnEnv({ cli: 'grok', provider: 'stale-provider' }),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
  assert.throws(
    () => providers.resolveSpawnEnv({ cli: 'zcode', provider: 'stale-provider' }),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
  assert.throws(
    () => providers.buildChildEnv(
      { PATH: '/usr/bin' },
      { cli: 'zcode', provider: 'stale-provider' },
      { MULTICC_SESSION_ID: 'zcode-session' },
    ),
    /Provider 不存在、协议不兼容或缺少可用的 HTTP 凭证/,
  );
});

test('host spawn paths route proxies by explicit provider capability', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.match(source, /appType === 'claude'/);
assert.match(source, /appType === 'codex'/);
  assert.doesNotMatch(source, /persisted\.cli !== 'qoder'\)\s*providers\.applyClaudeProxyEnv/);
  assert.doesNotMatch(source, /persisted\.cli !== 'codex' && persisted\.cli !== 'qoder'/);
});

test('vendor login flows map each vendor-auth CLI to a whitelisted login terminal spec', () => {
  const { VENDOR_LOGIN, vendorLoginForCli, cliForLoginFlow } = require('../src/cli-adapters/vendor-login');
  assert.deepEqual(Object.keys(VENDOR_LOGIN).sort(), ['codebuddy', 'qoder']);
  assert.equal(vendorLoginForCli('codebuddy').loginFlow, 'codebuddy-login');
  assert.equal(vendorLoginForCli('codebuddy').label, 'WorkBuddy');
  assert.equal(vendorLoginForCli('qoder').loginFlow, 'qoder-login');
  assert.equal(vendorLoginForCli(' CodeBuddy '), VENDOR_LOGIN.codebuddy, 'cli matching is case/space tolerant');
  assert.equal(vendorLoginForCli('claude'), null);
  assert.equal(vendorLoginForCli('dsh'), null, 'dsh uses DEEPSEEK_API_KEY, not TUI login');
  assert.equal(cliForLoginFlow('codebuddy-login'), 'codebuddy');
  assert.equal(cliForLoginFlow('qoder-login'), 'qoder');
  assert.equal(cliForLoginFlow('codex-login'), null, 'codex/claude login flows stay hardcoded in create-record');
  assert.equal(cliForLoginFlow('bogus'), null);
});


test('Pi local credentials do not acquire a MultiCC provider route', () => {
  assert.equal(providers.appTypeForCli('pi'), null);
  assert.deepEqual(providers.appTypesForCli('pi'), []);
  assert.equal(providers.providerSupportsCli({ apiFormat: 'anthropic' }, 'pi'), false);
  assert.deepEqual(providers.resolveSpawnEnv({ cli: 'pi', provider: 'stale-provider' }).env, {});
  const base = { PI_CODING_AGENT_DIR: '/pi-config', OPENAI_API_KEY: 'fixture-local-key' };
  assert.deepEqual(providers.buildChildEnv(base, { cli: 'pi' }).env, base);
});
