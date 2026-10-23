#!/usr/bin/env node
'use strict';

// Called only by the source-checkout manager, before its runtime checks.
// stdout is the selected addon path; build progress belongs on stderr.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sourcePaths, sourceFingerprint, probeAddon } = require('./rust-source-cache');

function ensureSourceRust({ repoRoot = path.resolve(__dirname, '..'), env = process.env,
  probe = probeAddon, paths = sourcePaths, run = spawnSync, log = console.error } = {}) {
  if (env.MULTICC_SQLITE_BACKEND === 'node' && String(env.MULTICC_CPR_BACKEND || 'node').trim().toLowerCase() !== 'rust') return null;
  const cache = paths(repoRoot, env);
  const target = `${process.platform}-${process.arch}`;
  const file = path.join(cache.prebuiltDir, target, 'multicc_core.node');
  const configured = env.MULTICC_RUST_ADDON || (env.MULTICC_RUST_PREBUILT_DIR
    && path.join(env.MULTICC_RUST_PREBUILT_DIR, target, 'multicc_core.node'));
  // A previous source-manager invocation may have exported an old cache path.
  // Source-owned caches must match today's fingerprint; external overrides
  // remain explicit and keep their priority.
  const relative = configured && path.relative(path.dirname(cache.prebuiltDir), path.resolve(configured));
  const ownCache = configured && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (configured && (!ownCache || path.resolve(configured) === file) && probe(path.resolve(configured))) return path.resolve(configured);
  if (probe(file)) return file;
  if (configured) log('指定的 Rust 模块不可用，将为当前源码重新构建。');
  log('未找到当前源码可用的 Rust 模块，正在自动编译（首次编译可能需要几分钟）…');
  const result = run(process.execPath, [path.join(repoRoot, 'scripts/build-rust-kernels.js'),
    '--out', cache.prebuiltDir, '--target-dir', cache.targetDir], {
    cwd: repoRoot, env: { ...env, MULTICC_RUST_ADDON: '' }, stdio: ['ignore', 2, 2],
  });
  if (result.error || result.status !== 0) {
    throw new Error('Rust 自动编译失败，服务尚未启动。源码开发需要可用的 Rust/Cargo 和平台链接工具；安装后重试 ./multicc start。');
  }
  if (sourceFingerprint(repoRoot, env) !== cache.fingerprint) {
    fs.rmSync(file, { force: true });
    throw new Error('编译期间 Rust 源码发生变化，请重新执行 ./multicc start。');
  }
  if (!probe(file)) throw new Error('Rust 产物未通过运行校验，服务尚未启动；请检查工具链及目标架构。');
  log('Rust 模块已就绪，后续启动将自动复用。');
  return file;
}

if (require.main === module) {
  try { const file = ensureSourceRust(); if (file) process.stdout.write(file + '\n'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { ensureSourceRust };
