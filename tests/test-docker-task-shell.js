'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { exportSources } = require('../scripts/build-task-shell-image');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-docker-export-'));
  const root = path.join(dir, 'source'), out = path.join(dir, 'export');
  fs.mkdirSync(root); fs.mkdirSync(out);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  const write = (file, content) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  for (const f of ['package-lock.json', 'docker/task-shell/Dockerfile', 'docker/task-shell/run-tests.js']) write(f, '{}');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  return { root, out, git, write, dir };
}
test('Docker export contains tracked worktree edits; excludes untracked secrets, runtime state and Git metadata', t => {
  const f = fixture(t);
  f.write('server.js', 'original'); f.git('add', 'server.js'); f.write('server.js', 'current edit');
  f.write('local-secret.txt', 'private');
  for (const file of ['.env', '.codex/auth.json', 'providers.json', 'node_modules/private/index.js']) { f.write(file, 'private'); f.git('add', '-f', file); }
  const manifest = exportSources(f.root, f.out);
  assert.equal(fs.readFileSync(path.join(f.out, 'server.js'), 'utf8'), 'current edit');
  for (const file of ['.git', '.env', '.codex', 'providers.json', 'node_modules', 'local-secret.txt']) assert.equal(fs.existsSync(path.join(f.out, file)), false, file);
  assert.match(manifest.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(manifest.files, 4);
});
test('Docker export rejects tracked symlinks to host files', t => {
  const f = fixture(t);
  const privateFile = path.join(f.dir, 'private'); fs.writeFileSync(privateFile, 'private');
  fs.symlinkSync(privateFile, path.join(f.root, 'leak')); f.git('add', 'leak');
  assert.throws(() => exportSources(f.root, f.out), /regular file inside/);
});
test('fake Codex emits resumable native identities without a real model', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-fake-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const binary = path.join(__dirname, '../docker/task-shell/fake-codex.js');
  const env = { PATH: process.env.PATH, MULTICC_SESSION_ID: 'isolated-test', CODEX_HOME: path.join(home, '.codex') };
  const output = execFileSync(process.execPath, [binary, 'exec', '--json', 'hello'], {
    env, encoding: 'utf8',
  }).trim().split('\n').map(JSON.parse);
  assert.equal(output[0].thread_id, 'lab-isolated-test');
  assert.equal(output.at(-1).type, 'turn.completed');
  assert.match(output[1].item.text, /未调用真实模型/);
  const file = path.join(env.CODEX_HOME, 'sessions/rollout-lab-isolated-test.jsonl');
  const first = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(first).payload.cwd, process.cwd());
  execFileSync(process.execPath, [binary, 'exec', 'resume', 'lab-isolated-test', 'followup'], { env });
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'resume preserves native metadata');
  const guard = require('../src/chat/codex-rollout-guard').createCodexRolloutGuard({ homeDir: home });
  assert.equal(guard.enforce({ cli: 'codex', cliSessionId: 'lab-isolated-test' }).action, 'ok');
});

test('构建与门禁并行，发布等待全部成功，任一门禁失败独立取消本次运行', () => {
  for (const [file, jobs] of [
    ['release.yml', ['android-apk']],
    ['desktop-release.yml', ['build', 'standalone']],
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../.github/workflows', file), 'utf8');
    assert.match(source, /clean-install:\s+uses: \.\/\.github\/workflows\/clean-install\.yml/);
    assert.match(source, /core-tests:\s+uses: \.\/\.github\/workflows\/core-tests\.yml/);
    const blocks = Object.fromEntries([...source.matchAll(/^  ([a-z][\w-]*):\n([\s\S]*?)(?=^  [a-z][\w-]*:\n|(?![\s\S]))/gm)]
      .map(match => [match[1], match[2]]));
    for (const job of jobs) {
      assert.ok(blocks[job], `${file}: 缺少构建 job ${job}`);
      assert.doesNotMatch(blocks[job], /^    needs:/m, `${job} 必须与测试同时可调度`);
      assert.doesNotMatch(blocks[job], /gh release (?:create|upload)/, '构建阶段不得发布');
    }
    const publish = blocks[file === 'release.yml' ? 'publish-apk' : 'release'];
    assert.ok(publish);
    const needs = publish.match(/^    needs: \[([^\]]+)\]/m)?.[1].split(',').map(s => s.trim());
    assert.deepEqual(needs, ['core-tests', 'clean-install', ...jobs]);
    assert.doesNotMatch(publish, /if:.*(?:always\(|failure\(|cancelled\()/, '发布不能绕过成功依赖');
    for (const [suffix, gate] of [['core', 'core-tests'], ['install', 'clean-install']]) {
      const cancel = blocks[`cancel-on-${suffix}-failure`];
      assert.ok(cancel);
      assert.ok(cancel.includes(`needs: [${gate}]`), '失败取消不等待另一项门禁完成');
      assert.ok(cancel.includes(`always() && needs.${gate}.result != 'success'`));
      assert.match(cancel, /actions: write/);
      assert.match(cancel, /uses: \.\/\.github\/workflows\/cancel-release\.yml/);
    }
  }
  const androidWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  assert.doesNotMatch(androidWorkflow, /npm run test:release(?:\s|$)/,
    'the Android build must not repeat the legacy full Node gate');
  assert.doesNotMatch(androidWorkflow, /flutter test/,
    'the Android build must not repeat the full Flutter suite');
  assert.match(androidWorkflow, /actions\/upload-artifact@v4[\s\S]*name: official-android-apk/);
  assert.match(androidWorkflow, /actions\/download-artifact@v4[\s\S]*name: official-android-apk/);
  assert.match(androidWorkflow, /GH_REPO: \$\{\{ github\.repository \}\}/);
  const coreWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/core-tests.yml'), 'utf8');
  assert.match(coreWorkflow, /npm run test:release:core/);
  assert.doesNotMatch(coreWorkflow, /MULTICC_SHELL_BROWSER_TEST/,
    'CDP remains outside the release core workflow');
  for (const command of ['CLAUDE_CMD', 'CODEX_CMD', 'OPENCODE_CMD', 'ZCODE_CMD']) {
    assert.match(coreWorkflow, new RegExp(`${command}: /bin/true`));
  }
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/clean-install.yml'), 'utf8');
  assert.match(workflow, /set -euo pipefail/);
  assert.match(workflow, /npm run test:release:clean-install/);
  assert.match(workflow, /if: always\(\)/);

  const installerGate = fs.readFileSync(path.join(__dirname, '../docker/task-shell/install-and-test.js'), 'utf8');
  assert.match(installerGate, /scripts\/standalone-bundle\.js/);
  assert.match(installerGate, /docker\/task-shell\/installed-smoke\.js/);
  assert.doesNotMatch(installerGate, /docker\/task-shell\/run-tests\.js/,
    'clean-install must not hide a second application regression suite');
  assert.doesNotMatch(installerGate, /await run\('npm', \['ci'/,
    'clean-install must stay a pristine installation test');
});


test('取消动作仅针对调用方当前工作流运行', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/cancel-release.yml'), 'utf8');
  const body = source.split('          script: |\n')[1];
  assert.ok(body);
  const calls = [];
  const github = { rest: { actions: { cancelWorkflowRun: async input => { calls.push(input); } } } };
  const context = { repo: { owner: 'fixture-owner', repo: 'fixture-repo' }, runId: 123 };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('github', 'context', body);
  await run(github, context);
  assert.deepEqual(calls, [{ owner: 'fixture-owner', repo: 'fixture-repo', run_id: 123 }]);
  await assert.rejects(run({ rest: { actions: { cancelWorkflowRun: async () => { throw new Error('取消 API 不可用'); } } } }, context), /取消 API 不可用/);
});
