'use strict';
// "Can voice input work, and if not what should the user do" (src/voice/readiness.js)
// plus the streaming path's matching voice_not_ready frame (plugins/voice/voice-asr.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { voiceReadiness } = require('../src/voice/readiness');

const installer = state => ({ status: () => ({ state, percent: 12, totalBytes: 100 }) });
const noLocal = { isAvailable: () => false };

test('reason mirrors the local model install state when nothing can recognise speech', () => {
  for (const state of ['missing', 'downloading', 'failed', 'unsupported', 'disabled']) {
    const r = voiceReadiness({ asrLocal: noLocal, installer: installer(state), voiceCfg: {} });
    assert.equal(r.ready, false);
    assert.equal(r.reason, state);
    assert.equal(r.download.state, state);
  }
  // An unknown installer state still offers the download, never a dead end.
  assert.equal(voiceReadiness({ asrLocal: noLocal, installer: installer('weird'), voiceCfg: {} }).reason, 'missing');
  assert.equal(voiceReadiness({ asrLocal: noLocal, voiceCfg: {} }).reason, 'missing');
});

test('local beats cloud; any cloud credential is enough; a throwing status probe is ignored', () => {
  assert.equal(voiceReadiness({ asrLocal: { isAvailable: () => true }, installer: installer('ready'), voiceCfg: { WHISPER_API_KEY: 'k' } }).engine, 'local');
  assert.equal(voiceReadiness({ asrLocal: noLocal, installer: installer('missing'), voiceCfg: { WHISPER_API_KEY: 'k' } }).engine, 'cloud');
  assert.equal(voiceReadiness({ asrLocal: noLocal, installer: installer('missing'), voiceCfg: {}, streamingStatus: () => ({ funasr: { ready: true } }) }).engine, 'cloud');
  const r = voiceReadiness({ asrLocal: noLocal, installer: installer('downloading'), voiceCfg: {}, streamingStatus: () => { throw new Error('x'); } });
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'downloading');
});

test('streaming: with nothing configured the socket says voice_not_ready, not "OpenAI key missing"', () => {
  const asr = require('../plugins/voice/voice-asr');
  const asrLocal = require('../src/voice/asr-local');
  const saved = JSON.parse(JSON.stringify(asr.cfg));
  const savedAvailable = asrLocal.isAvailable;
  asrLocal.isAvailable = () => false; // this machine may well have the model
  try {
    asr.applyConfig({ defaultProvider: 'auto', openaiApiKey: '', volcAppId: '', volcAccessToken: '', funasrUrl: '' });
    for (const k of ['openai', 'volcano', 'funasr']) {
      for (const f of ['apiKey', 'appId', 'accessToken', 'url']) if (f in asr.cfg[k]) asr.cfg[k][f] = '';
    }
    const ws = new EventEmitter();
    const sent = [];
    ws.send = data => sent.push(JSON.parse(data));
    asr.handleVoiceWs(ws, {}, new URL('http://x/ws/voice'));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', provider: 'auto', lang: 'zh' })), false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'error');
    assert.equal(sent[0].code, 'voice_not_ready');
    assert.equal(asr.providerStatus().default, 'none');
  } finally {
    asrLocal.isAvailable = savedAvailable;
    Object.assign(asr.cfg, saved);
  }
});
