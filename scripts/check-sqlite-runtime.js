#!/usr/bin/env node
'use strict';

// 校验随包提供的 Rust SQLite 模块；不依赖宿主 SQLite 或编译器。

const path = require('path');
const { databaseConstructor } = require('../src/sqlite/driver');

const EXIT_OK = 0;
const EXIT_SQLITE_UNAVAILABLE = 10;
const REQUIREMENT = 'matching Rust SQLite native module';

function runtimeDetails(runtime = process) {
  return {
    node: runtime.version,
    abi: runtime.versions && runtime.versions.modules,
    platform: runtime.platform,
    arch: runtime.arch,
  };
}

function errorMessage(error) {
  if (!error) return 'unknown error';
  return String(error.message || error).split('\n')[0];
}

// Loading the module is not a health check. Open and close a
// real in-memory database, exactly like the CC-Switch import does.
function checkSqliteRuntime({
  loadDatabase = () => databaseConstructor(),
  runtime = process,
} = {}) {
  const failures = [];
  try {
    const Database = loadDatabase();
    let database;
    try {
      database = new Database(':memory:');
    } finally {
      if (database && typeof database.close === 'function') database.close();
    }
  } catch (error) {
    failures.push({ dependency: 'rust:sqlite', message: errorMessage(error) });
  }

  return {
    ok: failures.length === 0,
    failures,
    requirement: REQUIREMENT,
    exitCode: failures.length === 0
      ? EXIT_OK
      : EXIT_SQLITE_UNAVAILABLE,
    runtime: runtimeDetails(runtime),
  };
}

function formatReport(result) {
  const r = result.runtime;
  if (result.ok) {
    return `SQLite runtime OK (Node ${r.node}, ${r.platform}/${r.arch}) — Rust SQLite module ready`;
  }
  return [
    'SQLite runtime check failed.',
    `Runtime: Node ${r.node}, ABI ${r.abi}, ${r.platform}/${r.arch}`,
    ...result.failures.map(failure => `- ${failure.dependency}: ${failure.message}`),
    `Repair: install the ${result.requirement}; source checkouts: npm run build:rust and configure MULTICC_RUST_PREBUILT_DIR.`,
  ].join('\n');
}

function main(options) {
  const result = checkSqliteRuntime(options);
  const output = formatReport(result);
  (result.ok ? console.log : console.error)(output);
  return result.exitCode;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  EXIT_OK,
  EXIT_SQLITE_UNAVAILABLE,
  REQUIREMENT,
  checkSqliteRuntime,
  formatReport,
  main,
  runtimeDetails,
};
