'use strict';

const fs = require('fs');
const { databaseConstructor } = require('./sqlite/driver');

// 数据库由打包的 Rust 原生模块提供；缺失模块与数据库文件缺失分别报告。
const RUNTIME_REQUIREMENT = '与当前平台和架构匹配的 Rust SQLite 模块';

function sqliteUnavailableMessage() {
  return 'SQLite 不可用，需要' + RUNTIME_REQUIREMENT
    + '；请安装完整 MultiCC 包，源码运行先执行 npm run build:rust 并配置 MULTICC_RUST_PREBUILT_DIR。';
}

function makeError(message, code, reason, cause) {
  const error = new Error(message);
  error.code = code;
  error.reason = reason;
  if (cause) error.cause = cause;
  return error;
}

// Opening a database is the only honest health check: a module that loads can
// still fail on the first statement. This adapter always opens and closes an
// in-memory database before reporting the runtime as ready.
//
// Failed probes are deliberately not cached, so an administrator who upgrades
// Node while MultiCC is running can recover without restarting the server.
function createSqliteRuntime({
  loadDatabase = () => databaseConstructor(),
  existsSync = fs.existsSync,
} = {}) {
  function probe() {
    let Database;
    try {
      Database = loadDatabase();
    } catch (cause) {
      return { available: false, reason: 'native-runtime-unavailable', cause };
    }

    let db;
    try {
      db = new Database(':memory:');
      db.close();
      db = null;
      return { available: true, reason: null, Database };
    } catch (cause) {
      try { if (db) db.close(); } catch (_) {}
      return { available: false, reason: 'native-runtime-unavailable', cause };
    }
  }

  function getStatus(dbPath) {
    const normalizedPath = String(dbPath || '');
    const dbFound = !!normalizedPath && existsSync(normalizedPath);
    if (!dbFound) {
      return {
        available: false,
        dbFound: false,
        dbPath: normalizedPath,
        reason: 'database-not-found',
        message: 'CC-Switch database was not found at ' + normalizedPath + '.',
      };
    }

    const runtime = probe();
    if (!runtime.available) {
      return {
        available: false,
        dbFound: true,
        dbPath: normalizedPath,
        reason: runtime.reason,
        message: sqliteUnavailableMessage(),
      };
    }

    return {
      available: true,
      dbFound: true,
      dbPath: normalizedPath,
      reason: null,
      message: '',
    };
  }

  function openReadonly(dbPath, options = {}) {
    const status = getStatus(dbPath);
    if (!status.available) {
      const code = status.reason === 'database-not-found'
        ? 'CC_SWITCH_DB_NOT_FOUND'
        : 'SQLITE_NATIVE_RUNTIME_UNAVAILABLE';
      throw makeError(status.message, code, status.reason);
    }

    // Probe again to obtain the constructor without keeping failed state. The
    // second probe is cheap and keeps getStatus() free of hidden mutable state.
    const runtime = probe();
    if (!runtime.available) {
      throw makeError(
        sqliteUnavailableMessage(),
        'SQLITE_NATIVE_RUNTIME_UNAVAILABLE',
        'native-runtime-unavailable',
        runtime.cause,
      );
    }

    try {
      return new runtime.Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 4000,
        ...options,
      });
    } catch (cause) {
      throw makeError(
        'Could not open the CC-Switch database. Check that the file is readable, then retry.',
        'CC_SWITCH_DB_OPEN_FAILED',
        'database-open-failed',
        cause,
      );
    }
  }

  return { getStatus, openReadonly, probe };
}

module.exports = {
  RUNTIME_REQUIREMENT,
  createSqliteRuntime,
  sqliteUnavailableMessage,
};
