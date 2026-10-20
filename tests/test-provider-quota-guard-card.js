'use strict';

// Client-side guard for the 官方账号额度保护 card on the Provider page.
//
// The card is the only place a user changes the guard thresholds, and it is
// deliberately on the Provider page (below the provider cards, above 更多连接方式):
// it protects those lines, not some global preference. These assertions keep the
// placement, the endpoint and the translation keys from drifting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'air-provider.js'), 'utf8');

test('the card saves through the settings endpoint and never to a second one', () => {
  assert.match(SOURCE, /context\.api\('\/api\/settings\/quota-guard'\)/);
  assert.match(SOURCE, /context\.api\('\/api\/settings\/quota-guard', \{[\s\S]*?\}, 'PUT'\)/);
  assert.equal(SOURCE.match(/\/api\/settings\/quota-guard/g).length, 2);
});

test('the card sits below the provider cards and above 更多连接方式', () => {
  const append = SOURCE.indexOf('page.append(intro, defaults, toolbar, cards, quotaGuardCard(), advanced)');
  assert.ok(append > 0, 'the card is part of the shell in that order');
  const card = SOURCE.indexOf("panel.id = 'air-quota-guard-card'");
  assert.ok(card > 0 && card < append);
});

test('threshold inputs cannot express a value the API would refuse', () => {
  assert.match(SOURCE, /input\.min = '1'; input\.max = '100'/);
  for (const id of ['five-hour', 'weekly', 'monthly']) {
    assert.match(SOURCE, new RegExp(`quotaGuardField\\('air-quota-guard-${id}'`));
  }
});

test('an env override is surfaced instead of being silently outvoted', () => {
  assert.match(SOURCE, /envOverrides/);
  assert.match(SOURCE, /airQuotaGuardEnvNote/);
});

test('every key the card asks for exists in both catalogs', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'assets', 'i18n', 'zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'assets', 'i18n', 'en.json'), 'utf8'));
  const keys = [...new Set(SOURCE.match(/airQuotaGuard[A-Za-z]+/g))];
  assert.ok(keys.length >= 15, `expected the card's full key set, saw ${keys.join(', ')}`);
  for (const key of keys) {
    assert.ok(zh[key], `zh.json is missing ${key}`);
    assert.ok(en[key], `en.json is missing ${key}`);
  }
});

test('the module still evaluates cleanly with the card in it', () => {
  const context = vm.createContext({
    t: key => key,
    window: {
      t: key => key,
      document: { getElementById: () => null, body: { append() {} }, querySelectorAll: () => [] },
      location: { search: '' },
      setInterval: () => 0,
    },
    URLSearchParams,
  });
  vm.runInContext(SOURCE, context, { filename: 'air-provider.js' });
  assert.equal(typeof context.window.MultiCCAirProvider.render, 'function');
  assert.equal(typeof context.window.MultiCCAirProvider.refresh, 'function');
});
