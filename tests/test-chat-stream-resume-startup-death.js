'use strict';

// A persisted streaming id can outlive Claude's transcript. With monitor
// admission on, pump() keeps the user message queued until the control
// handshake is ready, so the CLI reports "No conversation found" while
// `s.current` is still null. The recovery must rotate the id from there too;
// otherwise every respawn `--resume`s the same dead id and the turn never starts.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stream = require('../src/chat/chat-stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multicc-stream-resume-death-'));
const argLog = path.join(tmp, 'args.jsonl');
const fakeCli = [
  "const fs=require('fs')",
  "const argv=process.argv.slice(1)",
  "fs.appendFileSync(process.env.ARG_LOG, JSON.stringify(argv)+'\\n')",
  "const dead=argv.includes('--resume')&&argv.includes('dead-id')",
  "const msg='No conversation found with session ID: dead-id'",
  "if(dead){",
  "  process.stderr.write(msg+'\\n')",
  "  if(process.env.DEATH_MODE==='stdout')process.stdout.write(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,num_turns:0,errors:[msg]})+'\\n')",
  "  process.exit(1)",
  "}",
  "let buf=''",
  "process.stdin.on('data', c => {",
  "  buf += c.toString()",
  "  while (buf.includes('\\n')) {",
  "    const i=buf.indexOf('\\n'); const input=JSON.parse(buf.slice(0,i)); buf=buf.slice(i+1)",
  "    if(input.type==='control_request'){process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:input.request_id}})+'\\n');continue}",
  "    process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'})+'\\n')",
  "  }",
  "})",
  "process.stdin.on('end',()=>process.exit(0))",
].join(';');

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function run(name, mode) {
  fs.writeFileSync(argLog, '');
  const events = [];
  const captured = [];
  stream.ensure(name, {
    cmd: process.execPath,
    cwd: process.cwd(),
    sessionId: 'dead-id',
    baseArgs: ['-e', fakeCli, '--'],
    env: { ...process.env, ARG_LOG: argLog, DEATH_MODE: mode },
    resume: true,
    monitorAdmission: true,
    onBackgroundEvent: () => {},
    onNewSessionId: id => captured.push(id),
  });
  try {
    await withTimeout(stream.send(name, 'probe', event => events.push(event)), 8000, name);
  } finally {
    stream.close(name);
  }
  const rows = fs.readFileSync(argLog, 'utf8').trim().split('\n').map(JSON.parse);
  return { events, captured, rows };
}

(async () => {
  for (const mode of ['stdout', 'stderr']) {
    const r = await run(`startup-death-${mode}`, mode);
    assert.deepStrictEqual(r.rows[0].slice(-2), ['--resume', 'dead-id'],
      `${mode}: first spawn resumes the persisted id`);
    assert.strictEqual(r.rows.length, 2, `${mode}: exactly one fresh respawn, no resume loop (${JSON.stringify(r.rows)})`);
    assert.strictEqual(r.rows[1][r.rows[1].length - 2], '--session-id', `${mode}: respawn starts a new native session`);
    assert.notStrictEqual(r.rows[1][r.rows[1].length - 1], 'dead-id');
    assert.deepStrictEqual(r.captured, [r.rows[1][r.rows[1].length - 1]],
      `${mode}: the replacement id is persisted`);
    assert.strictEqual(r.events.length, 1, `${mode}: only the real result reaches the caller`);
    assert.strictEqual(r.events[0].subtype, 'success');
  }
  console.log('chat-stream startup-death resume recovery tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  stream.close('startup-death-stdout');
  stream.close('startup-death-stderr');
  fs.rmSync(tmp, { recursive: true, force: true });
});
