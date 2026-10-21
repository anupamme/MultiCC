#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const target = process.env.CARGO_TARGET_DIR || path.join(os.tmpdir(), 'multicc-read-model-target');
execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', path.join(__dirname, 'Cargo.toml')],
  { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target } });
const name = process.platform === 'darwin' ? 'libmulticc_read_model_experiment.dylib'
  : process.platform === 'win32' ? 'multicc_read_model_experiment.dll' : 'libmulticc_read_model_experiment.so';
const destination = path.join(target, 'read_model.node');
fs.copyFileSync(path.join(target, 'release', name), destination);
if (typeof require(destination).Experiment !== 'function') throw new Error('实验模块加载失败');
console.log(`实验模块已构建：${destination}`);
