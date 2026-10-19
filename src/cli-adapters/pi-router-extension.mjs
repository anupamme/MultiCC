// Pi has no native MCP support. Expose MultiCC's own stdio router as native
// extension tools; never change ~/.pi/agent or copy capability tokens to disk.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function createRouterClient(command, script, { env = process.env, timeoutMs = 21660000, shutdownGraceMs = 1000 } = {}) {
  const child = spawn(command, [script], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  let disposed = false;
  let killTimer;
  // Router stderr is diagnostic only. It must never pollute Pi's JSON stdout
  // or expose capabilities to the model. Drain it to prevent pipe deadlock.
  child.stderr.resume();
  function send(message) {
    if (closed) throw new Error('MultiCC router is closed');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }
  function finishAll(error) {
    closed = true;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }
  child.on('error', () => finishAll(new Error('MultiCC router could not start')));
  child.on('exit', () => finishAll(new Error('MultiCC router exited')));
  child.on('close', () => clearTimeout(killTimer));
  child.stdin.on('error', () => finishAll(new Error('MultiCC router input closed')));
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (!item) return;
    if (message.error) item.reject(new Error(message.error.message || 'MultiCC router request failed'));
    else item.resolve(message.result);
  });
  function request(method, params, { signal, timeout = timeoutMs } = {}) {
    if (closed) return Promise.reject(new Error('MultiCC router is closed'));
    if (signal?.aborted) return Promise.reject(new Error('MultiCC tool cancelled'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); };
      const settle = fn => value => { cleanup(); fn(value); };
      const cancel = reason => {
        try { send({ method: 'notifications/cancelled', params: { requestId: id, reason } }); } catch {}
        pending.get(id)?.reject(new Error(reason));
      };
      const abort = () => cancel('MultiCC tool cancelled');
      const timer = setTimeout(() => cancel('MultiCC router request timed out'), timeout);
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      signal?.addEventListener('abort', abort, { once: true });
      try { send({ id, method, params }); } catch (error) { pending.get(id)?.reject(error); }
    });
  }
  return {
    request,
    async initialize() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'multicc-pi', version: '1.0.0' } }, { timeout: 10000 });
      send({ method: 'notifications/initialized' });
      return request('tools/list', {}, { timeout: 10000 });
    },
    close() {
      if (disposed) return;
      disposed = true;
      finishAll(new Error('MultiCC router closed'));
      lines.close();
      child.stdin.destroy();
      child.kill();
      // A broken router must not outlive Pi indefinitely after shutdown.
      // Do not keep an otherwise exiting Pi process alive for this timer.
      if (child.exitCode === null && child.signalCode === null) {
        killTimer = setTimeout(() => child.kill('SIGKILL'), shutdownGraceMs);
        killTimer.unref();
      }
    },
  };
}

export default function multiccRouterExtension(pi) {
  pi.registerFlag('multicc-router-node', { description: 'MultiCC router Node executable', type: 'string' });
  pi.registerFlag('multicc-router-script', { description: 'MultiCC router script', type: 'string' });
  let client;
  pi.on('session_start', async () => {
    client?.close();
    if (!process.env.MULTICC_BASE_URL || !process.env.MULTICC_ROUTER_CAPABILITY) return;
    client = createRouterClient(pi.getFlag('multicc-router-node') || process.execPath,
      pi.getFlag('multicc-router-script') || fileURLToPath(new URL('../../scripts/multicc-router-mcp.js', import.meta.url)));
    try {
      const listing = await client.initialize();
      for (const tool of listing.tools || []) {
        pi.registerTool({
          name: `mcp__multicc_router__${tool.name}`,
          label: tool.title || tool.name,
          description: tool.description || tool.name,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
          async execute(_toolCallId, args, signal) {
            const result = await client.request('tools/call', { name: tool.name, arguments: args }, { signal });
            const content = (result.content || []).map(item => {
              if (item.type === 'text' || item.type === 'image') return item;
              return { type: 'text', text: item.resource?.text || item.uri || JSON.stringify(item) };
            });
            if (result.isError) throw new Error(content.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'MultiCC tool failed');
            return { content, details: result.structuredContent || {} };
          },
        });
      }
    } catch (error) {
      client.close();
      throw error;
    }
  });
  pi.on('session_shutdown', () => { client?.close(); client = undefined; });
}
