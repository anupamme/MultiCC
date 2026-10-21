'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  gitWorktreeAdd,
  gitWorktreeDetach,
  gitWorktreeValidate,
} = require('../src/git/service');
const { initializeSessionWorktrees } = require('../src/session/hibernation');
const { createSessionHibernation } = require('../src/session/hibernation-composition');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-hibernate-git-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'MultiCC Test']);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\napp/build/\n');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  return dir;
}

test('detach snapshots dirty and untracked files, preserves branch, reclaims cache and thaws bytes', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'bound-1', 'main');
  fs.writeFileSync(path.join(added.worktreePath, 'tracked.txt'), 'changed\n');
  fs.writeFileSync(path.join(added.worktreePath, 'new.txt'), Buffer.from([0, 1, 2, 255]));
  fs.mkdirSync(path.join(added.worktreePath, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(added.worktreePath, 'node_modules', 'pkg', 'cache.bin'), 'cache');

  const detached = await gitWorktreeDetach(dir, added.worktreePath, added.branch, {
    sessionId: 'bound-1',
  });
  assert.equal(detached.ok, true);
  assert.equal(detached.detached, true);
  assert.equal(fs.existsSync(added.worktreePath), false);
  assert.equal(git(dir, ['show-ref', '--verify', `refs/heads/${added.branch}`]).length > 0, true);
  assert.equal(git(dir, ['show', `${added.branch}:tracked.txt`]), 'changed');
  assert.equal(Buffer.from(git(dir, ['show', `${added.branch}:new.txt`]), 'binary').length > 0, true);

  const thawed = await gitWorktreeAdd(dir, 'bound-1', 'main', { requireExistingBranch: true });
  assert.equal(thawed.existing, false);
  assert.equal(fs.readFileSync(path.join(thawed.worktreePath, 'tracked.txt'), 'utf8'), 'changed\n');
  assert.deepEqual(fs.readFileSync(path.join(thawed.worktreePath, 'new.txt')), Buffer.from([0, 1, 2, 255]));
  assert.equal(fs.existsSync(path.join(thawed.worktreePath, 'node_modules')), false);
  assert.equal((await gitWorktreeValidate(dir, thawed.worktreePath, thawed.branch)).ok, true);
});

test('detach deletes unknown ignored files and returns an audit manifest', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'bound-secret', 'main');
  fs.writeFileSync(path.join(added.worktreePath, '.env'), 'SECRET=goes-away\n');
  const detached = await gitWorktreeDetach(dir, added.worktreePath, added.branch, { sessionId: 'bound-secret' });
  assert.equal(detached.ok, true);
  assert.equal(detached.detached, true);
  assert.equal(fs.existsSync(added.worktreePath), false);
  const entry = detached.removedUnknownIgnored.find(item => item.path === '.env');
  assert.ok(entry, 'manifest records the deleted unknown ignored file');
  assert.equal(entry.bytes, Buffer.byteLength('SECRET=goes-away\n'));
  assert.ok(entry.mtime);
  // The branch is retained, so a thaw still works — only the ignored file is gone.
  const thawed = await gitWorktreeAdd(dir, 'bound-secret', 'main', { requireExistingBranch: true });
  assert.equal(fs.existsSync(path.join(thawed.worktreePath, '.env')), false);
});

test('detach refuses a clean checkout with an in-progress Git operation', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'bound-merge', 'main');
  const marker = git(added.worktreePath, ['rev-parse', '--git-path', 'MERGE_HEAD']);
  fs.writeFileSync(path.isAbsolute(marker) ? marker : path.resolve(added.worktreePath, marker),
    `${git(added.worktreePath, ['rev-parse', 'HEAD'])}\n`);
  await assert.rejects(
    gitWorktreeDetach(dir, added.worktreePath, added.branch, { sessionId: 'bound-merge' }),
    error => error.code === 'HIBERNATE_GIT_OPERATION_ACTIVE' && error.operation === 'merge',
  );
  assert.equal(fs.existsSync(added.worktreePath), true);
  assert.equal(git(added.worktreePath, ['status', '--porcelain']), '');
});

test('requireExistingBranch never recreates a missing session branch from main', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    gitWorktreeAdd(dir, 'missing-bound', 'main', { requireExistingBranch: true }),
    error => error.code === 'WORKTREE_BRANCH_MISSING',
  );
  assert.throws(() => git(dir, ['show-ref', '--verify', 'refs/heads/multicc/missing-bound']));
});

test('path and branch validation rejects a checkout registered to another branch', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = await gitWorktreeAdd(dir, 'bound-a', 'main');
  git(dir, ['branch', 'multicc/bound-b', 'main']);
  const result = await gitWorktreeValidate(dir, added.worktreePath, 'multicc/bound-b');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'WORKTREE_BRANCH_MISMATCH');
  assert.equal(result.branchExists, true,
    'a checkout mismatch must not be misreported as an absent session branch');
});

test('启动缺失任务分支后，经生产唤醒组合恢复原会话工作区', async t => {
  const dir = repo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = 'startup-missing-bound';
  const original = await gitWorktreeAdd(dir, id, 'main');
  git(dir, ['worktree', 'remove', original.worktreePath]);
  git(dir, ['branch', '-d', original.branch]);
  const record = {
    id, dirId: 'dir', kind: 'chat', taskBoundTaskId: 'task-original',
    cliSessionId: 'native-original', workspaceState: 'awake',
    worktreePath: original.worktreePath, branch: original.branch,
  };
  const records = new Map([[id, record]]);
  const directories = new Map([['dir', { id: 'dir', path: dir, baseBranch: 'main' }]]);
  const invalidSessions = new Map();
  const chat = { cwd: original.worktreePath };
  const result = await initializeSessionWorktrees({
    records, directories, invalidSessions,
    realPathOf: value => fs.realpathSync(value), isHomeOrAbove: () => false,
    ensureDirGitReady: async () => ({ ok: true }), addWorktree: gitWorktreeAdd,
    tmuxHasSession: async () => false, tmuxKillSession: async () => {},
    saveDirectories: () => {}, saveSessions: () => {}, log: { log() {} },
  });
  assert.deepEqual(result, { built: 0, invalid: 0 });
  assert.equal(record.workspaceState, 'hibernated');
  assert.equal(fs.existsSync(original.worktreePath), false);
  assert.equal(git(dir, ['branch', '--list', original.branch]), '');

  const runtime = createSessionHibernation({
    records, directories, invalidSessions,
    persistence: { mutate: (_source, update) => update(records) },
    gitWorktreeAdd, gitWorktreeDetach, gitWorktreeValidate,
    chatSessions: new Map([[id, chat]]),
    workspaceBroadcast: () => {}, metrics: { inc() {} }, logger: { info() {}, warn() {} },
  });
  t.after(() => runtime.stop());
  const awake = await runtime.ensureAwake(id);
  assert.deepEqual(awake, { ok: true, thawed: true });
  assert.equal((await gitWorktreeValidate(dir, original.worktreePath, original.branch)).ok, true);
  assert.equal(git(original.worktreePath, ['rev-parse', 'HEAD']), git(dir, ['rev-parse', 'main']));
  assert.equal(record.id, id);
  assert.equal(record.taskBoundTaskId, 'task-original');
  assert.equal(record.cliSessionId, 'native-original');
  assert.equal(record.worktreePath, original.worktreePath);
  assert.equal(record.branch, original.branch);
  assert.equal(record.workspaceState, 'awake');
  assert.equal(record.workspaceStateErrorCode, null);
  assert.equal(chat.cwd, original.worktreePath);
  assert.equal(invalidSessions.has(id), false);
});

test('生产任务清理删除已合并分支后，重启及唤醒保留会话与历史', async t => {
  const { gitWorktreeRemove, gitMergeBack, gitWorktreeMergeState } = require('../src/git/service');
  const { defaultRepoActor } = require('../src/repo-actor');
  const { createTaskLifecycleHost } = require('../src/task-board/lifecycle-host');
  const { createSessionPersistence } = require('../src/session/persistence');
  const { mkRuntime } = require('./helpers/task-board-runtime');
  const dirPath = repo();
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }));
  const id = 'cleanup-bound', taskId = 'tsk-cleanup';
  const added = await gitWorktreeAdd(dirPath, id, 'main');
  fs.writeFileSync(path.join(added.worktreePath, 'tracked.txt'), 'delivered\n');
  const history = [{ id: 'message-original', role: 'user', content: '保留历史' }];
  const record = { id, dirId: 'dir-1', kind: 'chat', taskBoundTaskId: taskId,
    cliSessionId: 'native-original', workspaceState: 'awake', worktreePath: added.worktreePath, branch: added.branch };
  const records = new Map([[id, record]]);
  const directories = new Map([['dir-1', { id: 'dir-1', path: dirPath, baseBranch: 'main' }]]);
  let persisted;
  const persistence = createSessionPersistence({ records, store: { save: value => { persisted = structuredClone(value); } } });
  const invalidSessions = new Map();
  const chatSessions = new Map([[id, { cwd: added.worktreePath }]]);
  const runtime = createSessionHibernation({ records, directories, persistence, invalidSessions,
    gitWorktreeAdd, gitWorktreeRemove, gitWorktreeValidate, gitWorktreeDetach, gitWorktreeMergeState,
    defaultRepoActor, chatSessions,
    chatStream: { status: () => ({}), closeAndWait: async () => ({ closed: true }) },
    backgroundTaskRuntime: { hasProcessBackgroundTasks: () => false }, waitInjector: { hasWait: () => false },
    sessionWorkHost: { isRunActive: () => false }, getWorkspaceAdmission: () => null,
    workspaceBroadcast() {}, metrics: { inc() {} }, logger: { info() {}, warn() {} }, loadHistory: () => history });
  let board;
  const hooks = createTaskLifecycleHost({ records, getBoard: () => board.runtime.getBoard(),
    getShell: () => ({ stateTarget: () => ({}) }), getState: () => ({}), getRunState: () => 'idle',
    isSessionBusy: sid => !!defaultRepoActor.isLeased(sid), getHibernation: () => runtime });
  board = mkRuntime({ records, directories, ...hooks, gitWorktreeAdd, gitWorktreeRemove, gitMergeBack });
  t.after(async () => { await runtime.stop(); persistence.stop(); fs.rmSync(path.dirname(board.file), { recursive: true, force: true }); });
  board.runtime.getBoard().tasks[taskId] = { id: taskId, dirId: 'dir-1', chatSessionId: id,
    worktreePath: added.worktreePath, branch: added.branch };
  let cleanup;
  await defaultRepoActor.run(dirPath, 'publication-fixture', async () => {
    assert.ok(defaultRepoActor.isLeased(id));
    cleanup = require('../src/task-worktree').cleanupAfterPublication({
      repoActor: defaultRepoActor, dirPath, taskId, cleanup: board.runtime.taskWorktree.cleanupWorktree });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(records.get(id).workspaceState, 'awake');
    assert.equal(fs.existsSync(added.worktreePath), true);
  }, { sessionId: id });
  const result = await cleanup;
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(added.worktreePath), false);
  assert.equal(git(dirPath, ['branch', '--list', added.branch]), '');
  assert.equal(persisted[0].workspaceState, 'hibernated');
  assert.equal(board.runtime.getBoard().tasks[taskId].worktreePath, null);
  assert.equal(git(dirPath, ['show', 'main:tracked.txt']), 'delivered');
  records.set(id, structuredClone(persisted[0]));
  const startup = await initializeSessionWorktrees({ records, directories, invalidSessions,
    realPathOf: value => fs.realpathSync(value), isHomeOrAbove: () => false,
    ensureDirGitReady: async () => ({ ok: true }), addWorktree: gitWorktreeAdd,
    tmuxHasSession: async () => false, tmuxKillSession: async () => {},
    saveDirectories() {}, saveSessions() {}, log: { log() {} } });
  assert.equal(startup.invalid, 0);
  assert.equal((await runtime.ensureAwake(id)).ok, true);
  assert.equal(records.get(id).id, id);
  assert.equal(records.get(id).cliSessionId, 'native-original');
  assert.equal(records.get(id).taskBoundTaskId, taskId);
  assert.deepEqual(history, [{ id: 'message-original', role: 'user', content: '保留历史' }]);
  assert.equal(fs.readFileSync(path.join(added.worktreePath, 'tracked.txt'), 'utf8'), 'delivered\n');
  assert.equal((await gitWorktreeValidate(dirPath, added.worktreePath, added.branch)).ok, true);
});
