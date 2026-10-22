'use strict';

// Loopback port selection for the desktop shell. Mirrors the probe approach
// of src/network-policy.js but stays dependency-free so desktop/lib/* can be
// unit-tested under plain Node (no electron import anywhere in lib/).

const net = require('net');

const DEFAULT_PORT = Number.parseInt(process.env.MULTICC_DESKTOP_PORT || '3000', 10) || 3000;
const LOOPBACK_HOST = '127.0.0.1';

function probePort(port, host = LOOPBACK_HOST) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

// Walk upward from startPort and return the first free loopback port. A user
// who already runs the CLI server on 3000 simply gets 3001+ — no error, no
// terminal, no configuration.
async function findFreePort(startPort = DEFAULT_PORT, { host = LOOPBACK_HOST, maxTries = 100 } = {}) {
  const first = Number.isInteger(startPort) && startPort > 0 ? startPort : DEFAULT_PORT;
  for (let offset = 0; offset < maxTries; offset += 1) {
    const port = first + offset;
    if (port > 65535) break;
    if (await probePort(port, host)) return port;
  }
  throw new Error(`[desktop] no free port from ${first} on ${host} within ${maxTries} tries`);
}

class PortUnavailableError extends Error {
  constructor(port, host = LOOPBACK_HOST) {
    super(`端口 ${port} 已被占用（${host}），启动失败。请先停止占用该端口的进程，或改用其他端口。`);
    this.name = 'PortUnavailableError';
    this.code = 'EPORTUNAVAILABLE';
    this.port = port;
  }
}

// One rule for both the desktop shell and the standalone launcher:
//   no pinned port → start at startPort and walk forward to the first free one
//   pinned port    → use exactly that port; if it is taken, fail loudly
// Pinning is how an explicit user choice is honoured. Silently moving to the
// next port makes the choice look ignored (bookmarks, phone links, firewalls).
async function selectPort({
  pinnedPort = null,
  startPort = DEFAULT_PORT,
  host = LOOPBACK_HOST,
  probePortImpl = probePort,
  findFreePortImpl = findFreePort,
} = {}) {
  if (pinnedPort !== null && pinnedPort !== undefined) {
    if (!Number.isInteger(pinnedPort) || pinnedPort <= 0 || pinnedPort > 65535) {
      throw new Error(`无效的端口：${pinnedPort}（应为 1-65535 的整数）`);
    }
    if (!(await probePortImpl(pinnedPort, host))) throw new PortUnavailableError(pinnedPort, host);
    return pinnedPort;
  }
  return findFreePortImpl(startPort, { host });
}

module.exports = {
  DEFAULT_PORT, LOOPBACK_HOST, PortUnavailableError, findFreePort, probePort, selectPort,
};
