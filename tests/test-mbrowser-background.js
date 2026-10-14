'use strict';

// No real browser or daemon: exercise mode selection and attachment with fake
// lifecycle/CDP boundaries, using isolated profile state only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../skills/multicc-browser/lib/paths');
const CH = require('../skills/multicc-browser/lib/chrome');
const client = require('../skills/multicc-browser/lib/client');
const lifecycle = require('../skills/multicc-browser/lib/lifecycle');
const { Daemon } = require('../skills/multicc-browser/lib/daemon');

function isolate(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbrowser-background-'));
  const previous = { MULTICC_DATA_DIR: process.env.MULTICC_DATA_DIR, MBROWSER_PROFILES_DIR: process.env.MBROWSER_PROFILES_DIR };
  process.env.MULTICC_DATA_DIR = path.join(root, 'state');
  process.env.MBROWSER_PROFILES_DIR = path.join(root, 'profiles');
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  P.writeJson(P.configPath('work'), { name: 'work', headed: true });
}

for (const liveHeaded of [true, false]) {
  test(`ordinary start reuses a live ${liveHeaded ? 'headed' : 'headless'} browser without a mode change`, async t => {
    isolate(t);
    t.mock.method(client, 'ensureDaemon', async (name, options) => {
      assert.equal(Object.hasOwn(options.daemonOptions, 'headed'), false);
      return { pid: 123, headed: liveHeaded };
    });
    t.mock.method(client, 'call', async (name, command) => {
      assert.equal(command, 'status', 'ordinary start must not issue set-mode');
      return { headed: liveHeaded, chromePid: 456, userDataDir: P.profileDir(name) };
    });
    const result = await lifecycle.start({ name: 'work' });
    assert.equal(result.restarted, null);
    assert.match(result.text, new RegExp(`Chrome ${liveHeaded ? 'headed' : 'headless'}`));
  });
}

for (const headed of [true, false]) {
  test(`explicit ${headed ? 'headed' : 'headless'} mode remains a requested transition`, async t => {
    isolate(t);
    t.mock.method(client, 'ensureDaemon', async (name, options) => {
      assert.equal(options.daemonOptions.headed, headed);
      return { pid: 123, headed: !headed };
    });
    const commands = [];
    t.mock.method(client, 'call', async (name, command, args) => {
      commands.push(command);
      if (command === 'set-mode') {
        assert.equal(args.headed, headed);
        return { changed: true, headed };
      }
      return { headed };
    });
    const result = await lifecycle.start({ name: 'work', headed, headless: !headed });
    assert.deepEqual(commands, ['set-mode', 'status']);
    assert.match(result.text, new RegExp(`Chrome ${headed ? 'headed' : 'headless'} \\(restarted\\)`));
  });
}

test('conflicting mode flags fail before changing profile config or starting a daemon', async t => {
  isolate(t);
  const before = fs.readFileSync(P.configPath('work'), 'utf8');
  await assert.rejects(lifecycle.start({ name: 'work', headed: true, headless: true }), { code: 'usage' });
  assert.equal(fs.readFileSync(P.configPath('work'), 'utf8'), before);
});

test('cold implicit startup ignores a previous login mode and preserves the existing user-data-dir', async t => {
  isolate(t);
  const existingDir = path.join(P.defaultProfileRoot(), 'imported');
  P.writeJson(P.configPath('work'), { headed: true, userDataDir: existingDir });
  const daemon = new Daemon('work');
  t.mock.method(CH, 'readsDevToolsActivePort', () => null);
  t.mock.method(daemon, 'launchChrome', async () => {
    assert.equal(daemon.headed, false);
    assert.equal(daemon.userDataDir, existingDir);
  });
  await daemon.ensureChrome();
  assert.equal(daemon.launchChrome.mock.callCount(), 1);
  assert.equal(new Daemon('work', { headed: true }).headed, true);
});

for (const liveHeaded of [true, false]) {
  test(`daemon replacement restores live ${liveHeaded ? 'headed' : 'headless'} mode from runtime state`, async t => {
    isolate(t);
    P.writeJson(P.statePath('work'), { chromePid: 456, headed: liveHeaded, owned: true });
    const daemon = new Daemon('work', { headed: !liveHeaded });
    t.mock.method(CH, 'readsDevToolsActivePort', () => ({ port: 12345, wsPath: '/browser/fake' }));
    t.mock.method(CH, 'processAlive', () => true);
    t.mock.method(CH, 'isOurChrome', () => true);
    t.mock.method(daemon, 'connectBrowser', async () => {});
    t.mock.method(daemon, 'launchChrome', async () => assert.fail('live browser must be reused'));
    await daemon.ensureChrome();
    assert.equal(daemon.headed, liveHeaded);
    assert.equal(daemon.chromePid, 456);
  });
}

test('a page command after a headed browser exits restarts it in the background', async t => {
  isolate(t);
  const daemon = new Daemon('work', { headed: true });
  daemon.phase = 'chrome-down';
  t.mock.method(daemon, 'relaunch', async () => {
    assert.equal(daemon.headed, false);
    return true;
  });
  t.mock.method(daemon, 'restoreOwners', async () => {});
  await daemon.ensureReady();
  assert.equal(daemon.phase, 'ready');
});

test('attach-only profiles retain external mode and never relaunch a lost browser', async t => {
  isolate(t);
  P.writeJson(P.configPath('work'), { headed: true, attachOnly: true, cdpUrl: 'http://127.0.0.1:12345' });
  const daemon = new Daemon('work');
  t.mock.method(daemon, 'attachExternal', async () => {});
  t.mock.method(daemon, 'launchChrome', async () => assert.fail('external browser must never be launched'));
  await daemon.ensureChrome();
  assert.equal(daemon.attachExternal.mock.callCount(), 1);
  assert.equal(daemon.headed, true);
  await assert.rejects(daemon.ensureReady(), { code: 'chrome_down' });
  assert.equal(daemon.headed, true);
});

for (const savedHeaded of [true, false, undefined]) {
  test(`profile lock reuse recovers its mode (${String(savedHeaded)}) without spawning`, async t => {
    isolate(t);
    P.writeJson(P.statePath('work'), { chromePid: 456, ...(savedHeaded === undefined ? {} : { headed: savedHeaded }) });
    const daemon = new Daemon('work');
    t.mock.method(CH, 'singletonLockHolder', () => 456);
    t.mock.method(CH, 'readsDevToolsActivePort', () => ({ port: 12345, wsPath: '/browser/fake' }));
    t.mock.method(daemon, 'connectBrowser', async () => {});
    t.mock.method(CH, 'spawnChrome', () => assert.fail('locked live profile must not launch another browser'));
    await daemon.launchChrome();
    assert.equal(daemon.headed, savedHeaded === undefined ? true : savedHeaded);
    assert.equal(daemon.owned, false);
    assert.equal(daemon.chromePid, 456);
  });
}

test('page commands keep a live headed browser and its connection unchanged', async t => {
  isolate(t);
  const daemon = new Daemon('work', { headed: true });
  const connection = { closed: false };
  daemon.cdp = connection;
  daemon.phase = 'ready';
  t.mock.method(daemon, 'relaunch', async () => assert.fail('live browser must not restart'));
  await daemon.ensureReady();
  assert.equal(daemon.headed, true);
  assert.equal(daemon.cdp, connection);
});

// Focus is the one thing the user feels: a listing that reports the saved config
// instead of the live browser would hide a window sitting on their screen, and a
// stopped profile would look like it is about to open one. The note is there so
// callers keep away from those windows — not so they close or restart them.
test('listings name the profiles that really have a window on screen', async t => {
  isolate(t);
  // Live and headed: the only case that can steal focus.
  P.writeJson(P.configPath('window'), { name: 'window', headed: true });
  P.writeJson(P.statePath('window'), { chromePid: 456, headed: true, owned: true });
  // Live but headless: config says headed from an old login, the browser does not.
  P.writeJson(P.configPath('quiet'), { name: 'quiet', headed: true });
  P.writeJson(P.statePath('quiet'), { chromePid: 457, headed: false, owned: true });
  // Stopped: config says headed, the next start is still background.
  P.writeJson(P.configPath('stopped'), { name: 'stopped', headed: true });
  P.writeJson(P.statePath('stopped'), { chromePid: 458, headed: true, owned: true });
  // Attached to an external browser: a window exists, but it is not ours to
  // touch, so it must never appear in the note that names our own windows.
  P.writeJson(P.configPath('external'), {
    name: 'external', headed: true, attachOnly: true, cdpUrl: 'http://127.0.0.1:12345',
  });
  t.mock.method(CH, 'processAlive', pid => Number(pid) !== 458);

  const byName = Object.fromEntries(lifecycle.describeProfiles().map(profile => [profile.name, profile]));
  assert.equal(byName.window.mode, 'headed');
  assert.equal(byName.window.headed, true);
  assert.equal(byName.quiet.mode, 'headless');
  assert.equal(byName.quiet.headed, false);
  assert.equal(byName.stopped.headed, false, 'a stopped browser has no window');
  assert.equal(byName.stopped.mode, 'headless', 'a cold start is always headless');
  assert.equal(byName.external.mode, 'headed', 'an attached browser is headed');
  assert.equal(byName.external.headed, false, 'an attached browser is not our window');

  const listed = lifecycle.profiles();
  assert.match(listed.text, /quiet: headless/);
  assert.match(listed.text, /window: headed[\s\S]*\[window on screen\]/);
  assert.equal((listed.text.match(/\[window on screen\]/g) || []).length, 1,
    'only the live headed browser may be reported as a window');
  assert.match(listed.text, /headed windows \(1\): window/);
  assert.match(listed.text, /reuse them in place/);
  // Nothing in a listing may suggest handing a running browser back to the
  // background by restarting it: the window is not the problem, focus is.
  assert.doesNotMatch(listed.text, /--headless|mbrowser start NAME/);

  const report = await lifecycle.doctor({});
  assert.match(report.text, /window: headed[\s\S]*\[window on screen\]/);
  assert.match(report.text, /headed windows \(1\): window/);
  assert.equal(report.profiles.find(profile => profile.name === 'window').headed, true);
});

// The default has to be readable from the skill itself: an agent that only reads
// the contract must learn that focus is what is forbidden — not the window, and
// never "restart it headless to be quiet".
test('the skill states the background-first focus contract', async () => {
  const skill = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'multicc-browser', 'SKILL.md'), 'utf8');
  assert.match(skill, /焦点契约|focus contract/);
  assert.match(skill, /默认全程后台|background by default|background-first/i);
  assert.match(skill, /不激活、不置前/);
  assert.match(skill, /不改模式、不重启/);
  assert.match(skill, /必须由用户亲手完成[\s\S]{0,40}扫码/);
  // No handback ritual: nothing may send a running browser back to headless, and
  // the login flow must end in the same window rather than in a restart.
  assert.doesNotMatch(skill, /交回后台/);
  assert.doesNotMatch(skill, /start "?\$?\{?PROFILE\}?"? --headless/);
});

// The login flow is the one place that really opens a window, so it is where a
// "hand it back" habit would come from: it must end by staying put instead.
test('login keeps its headed window instead of handing the profile back', async t => {
  isolate(t);
  t.mock.method(client, 'ensureDaemon', async () => ({ pid: 123, version: 'test' }));
  t.mock.method(client, 'call', async (name, command) => {
    if (command === 'open') return { shortId: 't1' };
    if (command === 'set-mode') return { changed: true, headed: true };
    return {
      headed: true, chromePid: 456, userDataDir: P.profileDir(name), socket: P.socketPath(name),
    };
  });
  const result = await lifecycle.login({ name: 'work', url: 'https://site.example/login' });
  assert.match(result.text, /keep working in this same window/);
  assert.match(result.text, /do not restart or close this browser/);
  assert.doesNotMatch(result.text, /--headless|--mode|hand it back/);
});
