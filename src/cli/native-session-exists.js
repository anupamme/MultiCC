'use strict';

// Does the target CLI still hold the native session MultiCC remembers for it?
// Tri-state on purpose: true = present, false = definitely gone, null = cannot
// tell. Callers drop a remembered id only on `false`, so a CLI without a probe,
// a missing DB or a locked/unreadable store never costs the user their context.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function opencodeDbPath(env = process.env) {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

function opencodeSessionExists(sessionId, { dbPath = opencodeDbPath() } = {}) {
  if (!sessionId || !fs.existsSync(dbPath)) return null;
  let db = null;
  try {
    const Database = require('better-sqlite3');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return db.prepare('SELECT 1 FROM session WHERE id = ? LIMIT 1').get(String(sessionId)) !== undefined;
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

const PROBES = Object.freeze({
  opencode: (state, opts) => opencodeSessionExists(state.cliSessionId, opts),
});

function nativeSessionExists(cli, state, opts) {
  const probe = PROBES[cli];
  if (!probe || !state || !state.cliSessionId) return null;
  return probe(state, opts);
}

module.exports = { nativeSessionExists, opencodeSessionExists, opencodeDbPath };
