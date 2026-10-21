'use strict';

// Does the target CLI still hold the native session MultiCC remembers for it?
// Tri-state on purpose: true = present, false = definitely gone, null = cannot
// tell. Callers drop a remembered id only on `false`, so a CLI without a probe,
// a missing store or an unreadable/oversized one never costs the user their
// context. `false` additionally requires that at least one store root was
// actually read, so "the CLI was never installed here" can never look like
// "the session was deleted".
//
// Store layouts (verified against the ids persisted in sessions.json, 2026-10):
//   claude, claude-exp  <configDir>/projects/<cwd-slug>/<id>.jsonl, over
//                       $CLAUDE_CONFIG_DIR, ~/.claude and every Claude
//                       official-account home (~/.multicc/official-accounts/
//                       claude/<id>.home). Plain claude resumes by
//                       _streamSessionId (cliSessionId may name another
//                       transcript); the SDK lane resumes by cliSessionId.
//   codex, codex-exp    rollout-<ts>-<id>.jsonl under <codexHome>/sessions and
//                       archived_sessions, for ~/.codex plus every per-provider,
//                       per-task and per-attempt home MultiCC materializes.
//   opencode            row in the `session` table of opencode.db.
//   qoder               <~/.qoder-cn|.qoder-cli|.qoder>/projects/<slug>/<id>
//   codebuddy           ~/.codebuddy/projects/<slug>/<id>.jsonl
//   commandcode         ~/.commandcode/projects/<slug>/<id>.jsonl
//   dsh                 ~/.dsh/sessions/<slug>/<id>/ (the id is the directory)
// zcode, kimi, gemini and grok have no layout verified against real ids (see
// native-session-guard.js), so they stay "unknown" instead of guessing.
// Pi also stays unknown: its default timestamp_uuid.jsonl store is known, but
// sessionDir can be overridden by project/global settings and environment.
// A scan of ~/.pi/agent/sessions alone cannot establish that a session is gone.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_WALK_ENTRIES = 200_000;

function isMissing(error) {
  return !!error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function listDir(dir, io) {
  try { return io.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

function childDirs(dir, io) {
  const entries = listDir(dir, io);
  return entries ? entries.filter(e => e.isDirectory()).map(e => path.join(dir, e.name)) : [];
}

function exists(p, io) {
  try { io.statSync(p); return true; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

// Look for any of `names` directly inside every `<projectsDir>/<slug>/`.
// Layout-agnostic about the slug: the SDK canonicalizes symlinks, hashes long
// paths and supports custom project names, so we never rebuild it from a cwd.
function projectsHave(projectsDirs, names, io) {
  let sawRoot = false;
  for (const projects of projectsDirs) {
    const slugs = listDir(projects, io);
    if (!slugs) continue;
    sawRoot = true;
    for (const slug of slugs) {
      if (!slug.isDirectory() && !slug.isSymbolicLink()) continue;
      for (const name of names) {
        if (exists(path.join(projects, slug.name, name), io)) return true;
      }
    }
  }
  return sawRoot ? false : null;
}

// Bounded walk for a file whose name embeds the id. Exceeding the bound is
// "unknown", never "gone".
function walkHas(roots, matches, io) {
  let sawRoot = false;
  let inspected = 0;
  for (const root of roots) {
    if (!listDir(root, io)) continue;
    sawRoot = true;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      const entries = listDir(dir, io);
      if (!entries) continue;
      for (const entry of entries) {
        if ((inspected += 1) > MAX_WALK_ENTRIES) return null;
        if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
        else if (entry.isFile() && matches(entry.name)) return true;
      }
    }
  }
  return sawRoot ? false : null;
}

function claudeConfigDirs({ home, env, io }) {
  const dirs = [env.CLAUDE_CONFIG_DIR, path.join(home, '.claude')];
  const accounts = path.join(home, '.multicc', 'official-accounts', 'claude');
  for (const dir of childDirs(accounts, io)) {
    if (dir.endsWith('.home')) dirs.push(dir, path.join(dir, '.claude'));
  }
  return [...new Set(dirs.filter(Boolean))];
}

function codexHomes({ home, env, io }) {
  const homes = [env.CODEX_HOME, path.join(home, '.codex')];
  for (const base of ['codex-homes', 'codex-session-homes', 'codex-attempt-homes']) {
    homes.push(...childDirs(path.join(home, '.multicc', base), io));
  }
  return [...new Set(homes.filter(Boolean))];
}

function opencodeDbPath(env = process.env) {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

function opencodeSessionExists(sessionId, { dbPath = opencodeDbPath() } = {}) {
  if (!sessionId || !fs.existsSync(dbPath)) return null;
  let db = null;
  try {
    const Database = require('../sqlite/driver').databaseConstructor();
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return db.prepare('SELECT 1 FROM session WHERE id = ? LIMIT 1').get(String(sessionId)) !== undefined;
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

// The id each lane actually passes to its resume flag.
function resumeId(cli, state) {
  if (!state) return null;
  const id = cli === 'claude'
    ? (state.streamSessionId || state.cliSessionId)
    : state.cliSessionId;
  return id ? String(id) : null;
}

const claudeProbe = (id, ctx) => projectsHave(
  claudeConfigDirs(ctx).map(dir => path.join(dir, 'projects')), [`${id}.jsonl`], ctx.io);

const codexProbe = (id, ctx) => walkHas(
  codexHomes(ctx).flatMap(dir => [path.join(dir, 'sessions'), path.join(dir, 'archived_sessions')]),
  name => name.endsWith('.jsonl') && name.includes(id), ctx.io);

const PROBES = Object.freeze({
  claude: claudeProbe,
  'claude-exp': claudeProbe,
  codex: codexProbe,
  'codex-exp': codexProbe,
  opencode: (id, ctx) => opencodeSessionExists(id, ctx.opts),
  qoder: (id, ctx) => projectsHave(
    ['.qoder-cn', '.qoder-cli', '.qoder'].map(dir => path.join(ctx.home, dir, 'projects')),
    [id, `${id}.jsonl`], ctx.io),
  codebuddy: (id, ctx) => projectsHave(
    [path.join(ctx.home, '.codebuddy', 'projects')], [`${id}.jsonl`], ctx.io),
  commandcode: (id, ctx) => projectsHave(
    [path.join(ctx.home, '.commandcode', 'projects')], [`${id}.jsonl`], ctx.io),
  dsh: (id, ctx) => projectsHave(
    [path.join(ctx.home, '.dsh', 'sessions')], [id], ctx.io),
});

// opts: { dbPath, homeDir, env, fs } — all injectable for tests.
// MULTICC_NATIVE_SESSION_PROBE=0 turns every probe into "unknown" (the
// pre-probe behaviour): an escape hatch for fixtures whose fake CLIs invent
// native ids that exist in no real store.
function nativeSessionExists(cli, state, opts = {}) {
  if ((opts.env || process.env).MULTICC_NATIVE_SESSION_PROBE === '0') return null;
  const probe = PROBES[cli];
  const id = resumeId(cli, state);
  // Ids reach path.join(); anything that could escape a store directory is
  // simply not something we can vouch for either way.
  if (!probe || !id || /[\\/\0]/.test(id) || id === '.' || id === '..') return null;
  const ctx = {
    home: opts.homeDir || os.homedir(),
    env: opts.env || process.env,
    io: opts.fs || fs,
    opts,
  };
  try { return probe(id, ctx); } catch (_) { return null; }
}

module.exports = { nativeSessionExists, opencodeSessionExists, opencodeDbPath, resumeId };
