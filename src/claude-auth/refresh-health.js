'use strict';

// Durable memory for the OAuth refreshers.
//
// Everything the refreshers learn about a credential used to live in process
// memory, so a restart forgot it and the very first tick started the ladder
// again. That is how one dead account produced a CLI spawn every twelve
// minutes for thirteen days: each process-wide `consecutiveFailures` counter
// began at zero, and nothing ever wrote down "this one is already known to be
// dead, stop knocking". The counters are also the only record of *why* a
// refresh failed — the log line carried exit codes, never the CLI's stderr, so
// a revoked token and a dead network looked identical after the fact.
//
// This store is deliberately small and boring: one JSON object per credential,
// written atomically, read synchronously once when its refresher is built. It
// lives under the official-accounts root (never a new ~/.multicc write root),
// holds no tokens — an expiry timestamp and a failure classification are all a
// caller needs to decide what to do next — and is owned by whoever holds the
// credential, so the per-account rotator and the CLI's own login each get one
// file.
//
// Failure is contained: a health write that cannot land must never take the
// refresh path with it. Losing the file only costs a second lesson; losing the
// attempt would cost the login.

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteJson, ensurePrivateDir, secureFile } = require('../runtime-security');

// Account ids are hex; the CLI's own login is a fixed name. Keeping the key
// space this narrow is what makes `path.join(dir, key + '.json')` safe.
const KEY_PATTERN = /^[a-z0-9_-]{1,64}$/i;

function createRefreshHealthStore({ root, logger = null } = {}) {
  if (!root) throw new TypeError('[claude-refresh-health] root is required');
  const dir = path.join(root, 'refresh-health');
  const cache = new Map();

  const fileFor = key => path.join(dir, `${key}.json`);
  const usable = key => KEY_PATTERN.test(String(key || ''));

  // Synchronous on purpose: a refresher is constructed once at startup, and
  // deciding whether to park must be answerable before the first tick fires.
  function read(key) {
    if (!usable(key)) return null;
    if (cache.has(key)) return cache.get(key);
    let value = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
    } catch (_) {
      // Absent or unreadable both mean "nothing learned yet".
      value = null;
    }
    cache.set(key, value);
    return value;
  }

  function write(key, value) {
    if (!usable(key) || !value || typeof value !== 'object') return false;
    const record = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...value,
    };
    cache.set(key, record);
    try {
      ensurePrivateDir(dir);
      atomicWriteJson(fileFor(key), record);
      secureFile(fileFor(key));
      return true;
    } catch (error) {
      // Bookkeeping around a refresh must never mask the refresh itself.
      if (logger && typeof logger.warn === 'function') {
        logger.warn('claude_refresh_health_write_failed', { key, error: error.message });
      }
      return false;
    }
  }

  function clear(key) {
    if (!usable(key)) return false;
    cache.delete(key);
    try {
      fs.rmSync(fileFor(key), { force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  return Object.freeze({ dir, read, write, clear });
}

module.exports = { createRefreshHealthStore, KEY_PATTERN };
