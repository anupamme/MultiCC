'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { verify } = require('./build-rust-kernels');

// Electron 和 standalone 共用。只复制目标架构，禁止宿主二进制冒充交叉构建产物。
function stageRustKernels({ repoRoot, out, npmEnv = {}, logger = console }) {
  const platform = npmEnv.npm_config_platform || process.platform;
  const arch = npmEnv.npm_config_arch || process.arch;
  const root = process.env.MULTICC_RUST_PREBUILT_DIR || path.join(repoRoot, 'native/prebuilt');
  const relative = path.join(`${platform}-${arch}`, 'multicc_core.node');
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) {
    throw new Error(`打包缺少 Rust 模块：${platform}-${arch}`);
  }
  verify(source, platform, arch);
  const dest = path.join(out, 'native/prebuilt', relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  logger.log(`[Rust] 已打包 ${platform}-${arch}`);
  return dest;
}
module.exports = { stageRustKernels };
