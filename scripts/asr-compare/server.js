#!/usr/bin/env node
'use strict';
// Local ASR comparison bench.
//
// Runs SenseVoiceSmall and the streaming Zipformer transducers side by side on
// whatever you say into the page, so the choice of default can be made from
// your own voice instead of a TTS benchmark. Nothing here touches the running
// MultiCC server: it is a standalone process, own port, own recognizers.
//
// Requires sherpa-onnx-node >= 1.13.8 — 1.13.4 returns an empty transcript for
// every streaming transducer. Point SHERPA_ONNX_NODE at a node_modules copy
// (or install 1.13.8 in the repo) when the local one is older.
//
//   node scripts/asr-compare/server.js            # http://127.0.0.1:8899
//   PORT=9000 SHERPA_ONNX_NODE=/path/to/sherpa-onnx-node node ...

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || process.env.ASR_COMPARE_PORT || 8899);
const HOST = process.env.ASR_COMPARE_HOST || '127.0.0.1';
const MODEL_ROOT = process.env.ASR_LOCAL_MODEL_DIR || path.join(os.homedir(), '.multicc', 'asr-models');

// ── 在线 ASR 的口子 ──
// Any OpenAI-compatible POST /audio/transcriptions endpoint can be plugged in:
// by default the bench reuses whatever the app already has in .env, and the
// page can override base URL / model / key per recording. ASR_COMPARE_ENV points
// the bench at a different .env when it runs outside a full checkout.
const ENV_FILE = process.env.ASR_COMPARE_ENV || path.join(__dirname, '..', '..', '.env');
function loadEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch (_) {}
  return out;
}
const ENV_VARS = loadEnvFile(ENV_FILE);
const CFG = key => process.env[key] !== undefined && process.env[key] !== ''
  ? process.env[key] : (ENV_VARS[key] || '');
const CLOUD = {
  baseUrl: CFG('WHISPER_BASE_URL') || 'https://api.openai.com/v1',
  // The app falls back to the OpenRouter key for Whisper; mirror that.
  key: CFG('WHISPER_API_KEY') || CFG('OPENROUTER_API_KEY'),
  model: CFG('WHISPER_MODEL') || 'whisper-1',
  language: CFG('WHISPER_LANGUAGE') || 'zh',
};

const DIRS = {
  sense: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
  bi: 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
  zh25: 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
  mul: 'sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-2025-02-10',
};
const dirOf = k => path.join(MODEL_ROOT, DIRS[k]);

let sherpa = null;
let sherpaVersion = '';
let sherpaError = null;
function loadSherpa() {
  if (sherpa !== null) return sherpa;
  const candidates = [
    process.env.SHERPA_ONNX_NODE,
    'sherpa-onnx-node',
    path.join(__dirname, '..', '..', 'node_modules', 'sherpa-onnx-node'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      sherpa = require(c);
      try { sherpaVersion = require(path.join(c, 'package.json')).version; } catch (_) { sherpaVersion = '?'; }
      console.log(`[asr-compare] sherpa-onnx-node ${sherpaVersion} from ${c}`);
      return sherpa;
    } catch (e) { sherpaError = e.message; }
  }
  throw new Error(`sherpa-onnx-node 不可用: ${sherpaError}`);
}
function hasModel(k) {
  if (k === 'cloud') return true;   // no weights; readiness is the key
  const d = dirOf(k);
  try {
    if (k === 'sense') return fs.existsSync(path.join(d, 'model.int8.onnx')) && fs.existsSync(path.join(d, 'tokens.txt'));
    if (k === 'bi') return fs.existsSync(path.join(d, 'encoder-epoch-99-avg-1.int8.onnx'));
    if (k === 'zh25') return fs.existsSync(path.join(d, 'encoder.int8.onnx'));
    if (k === 'mul') return fs.existsSync(path.join(d, 'encoder-epoch-75-avg-11-chunk-16-left-128.int8.onnx'));
  } catch (_) {}
  return false;
}

// ── recognizers (lazy, one per engine) ──
const recognizers = new Map();
function engineConfig(k, opts = {}) {
  const d = dirOf(k);
  if (k === 'sense') {
    return {
      kind: 'offline',
      cfg: {
        modelConfig: {
          senseVoice: {
            model: path.join(d, 'model.int8.onnx'),
            language: process.env.ASR_LOCAL_LANGUAGE || 'auto',
            useInverseTextNormalization: 1,
          },
          tokens: path.join(d, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      },
    };
  }
  if (k === 'bi') {
    const modelConfig = {
      transducer: {
        encoder: path.join(d, 'encoder-epoch-99-avg-1.int8.onnx'),
        decoder: path.join(d, 'decoder-epoch-99-avg-1.int8.onnx'),
        joiner: path.join(d, 'joiner-epoch-99-avg-1.int8.onnx'),
      },
      tokens: path.join(d, 'tokens.txt'),
      // English tokens in this vocabulary are upper case, so hotwords have to
      // be upper case too or the encoder cannot find IDs for them.
      bpeVocab: path.join(d, 'bpe.vocab'),
      modelingUnit: 'cjkchar+bpe',
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    };
    return { kind: 'online', cfg: onlineCfg(modelConfig, opts) };
  }
  if (k === 'zh25') {
    const modelConfig = {
      transducer: {
        encoder: path.join(d, 'encoder.int8.onnx'),
        decoder: path.join(d, 'decoder.onnx'),
        joiner: path.join(d, 'joiner.int8.onnx'),
      },
      tokens: path.join(d, 'tokens.txt'),
      // No bpe.vocab in this release and no ASCII tokens at all: Chinese only.
      modelingUnit: 'cjkchar',
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    };
    return { kind: 'online', cfg: onlineCfg(modelConfig, opts) };
  }
  const modelConfig = {
    transducer: {
      encoder: path.join(d, 'encoder-epoch-75-avg-11-chunk-16-left-128.int8.onnx'),
      decoder: path.join(d, 'decoder-epoch-75-avg-11-chunk-16-left-128.onnx'),
      joiner: path.join(d, 'joiner-epoch-75-avg-11-chunk-16-left-128.int8.onnx'),
    },
    tokens: path.join(d, 'tokens.txt'),
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  };
  return { kind: 'online', cfg: onlineCfg(modelConfig, opts) };
}
function onlineCfg(modelConfig, opts) {
  const cfg = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig,
    decodingMethod: 'greedy_search',
    maxActivePaths: 1,
  };
  if (opts.hotwordsFile) {
    cfg.decodingMethod = 'modified_beam_search';
    cfg.maxActivePaths = Math.max(2, Number(opts.maxActivePaths) || 4);
    cfg.hotwordsFile = opts.hotwordsFile;
    cfg.hotwordsScore = Number(opts.hotwordsScore) || 3;
  }
  return cfg;
}
// Recognizers hold the whole acoustic model in native memory (~500MB each), so
// they are cached — but a hotword-boosted recognizer is built from a *file*, so
// the cache key has to be the hotword signature, not the file name (a fresh
// temp file every request would build a new model every request). Keep the
// window small: the user edits the box a handful of times per session.
const MAX_CACHED = 6;
function getRecognizer(k, opts) {
  const key = `${k}|${opts.hotwordSig || ''}`;
  if (recognizers.has(key)) {
    const hit = recognizers.get(key);
    recognizers.delete(key); recognizers.set(key, hit);   // LRU touch
    return hit;
  }
  const s = loadSherpa();
  const { kind, cfg } = engineConfig(k, opts);
  const rec = kind === 'offline' ? new s.OfflineRecognizer(cfg) : new s.OnlineRecognizer(cfg);
  recognizers.set(key, rec);
  while (recognizers.size > MAX_CACHED) recognizers.delete(recognizers.keys().next().value);
  return rec;
}

// ── decode helpers ──
function int16ToFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}
function parseWavPcm16(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    let off = 12, fmt = null, data = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ') fmt = { audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
      else if (id === 'data') data = buf.subarray(body, Math.min(body + size, buf.length));
      off = body + size + (size % 2);
    }
    if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) return null;
    const int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
    let samples;
    if (fmt.channels === 1) samples = int16ToFloat32(int16);
    else {
      samples = new Float32Array(Math.floor(int16.length / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = (int16[2 * i] + int16[2 * i + 1]) / 2 / 32768;
    }
    return { samples, sampleRate: fmt.sampleRate };
  } catch (_) { return null; }
}
function ffmpegDecode(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1']);
    const chunks = []; let err = '';
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (_) {} reject(new Error('ffmpeg 解码超时')); }, 20000);
    ff.stdout.on('data', c => chunks.push(c));
    ff.stderr.on('data', c => { err += c; });
    ff.on('error', e => { clearTimeout(timer); reject(new Error('ffmpeg 不可用: ' + e.message)); });
    ff.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg 失败(${code}): ${err.slice(0, 200)}`));
      const all = Buffer.concat(chunks);
      resolve(new Float32Array(all.buffer, all.byteOffset, Math.floor(all.byteLength / 4)));
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(buf);
  });
}
async function decodeAudio(buf) {
  const wav = parseWavPcm16(buf);
  if (wav && wav.sampleRate === 16000) return wav.samples;
  if (wav && wav.sampleRate !== 16000) return ffmpegDecode(buf);
  return ffmpegDecode(buf);
}

function transcribeOffline(rec, samples) {
  const t0 = Date.now();
  const st = rec.createStream();
  st.acceptWaveform({ sampleRate: 16000, samples });
  rec.decode(st);
  const r = rec.getResult(st);
  return { text: (r.text || '').trim(), ms: Date.now() - t0 };
}
function transcribeOnline(rec, samples) {
  const t0 = Date.now();
  const st = rec.createStream();
  st.acceptWaveform({ sampleRate: 16000, samples });
  // 0.4s of trailing silence flushes the last chunk of the encoder.
  st.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(6400) });
  while (rec.isReady(st)) rec.decode(st);
  const r = rec.getResult(st);
  const ctx = Math.max(0, ...(r.context_scores || [0]));
  return { text: (r.text || '').trim(), ms: Date.now() - t0, ctx };
}

// ── hotword files ──
function hotwordFileFor(engine, text, score) {
  const words = String(text || '').split(/\r?\n/).map(w => w.trim()).filter(Boolean);
  if (!words.length) return null;
  let lines;
  if (engine === 'bi') {
    // Upper-case ASCII to match this model's vocabulary; CJK is untouched.
    lines = words.map(w => w.replace(/[A-Za-z]+/g, s => s.toUpperCase()));
  } else if (engine === 'zh25') {
    lines = words.filter(w => !/[A-Za-z]/.test(w));
  } else return null;
  if (!lines.length) return null;
  const body = lines.map(l => `${l}${score ? ` :${score}` : ''}`).join('\n') + '\n';
  const sig = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
  const file = path.join(os.tmpdir(), `mcc-hw-${engine}-${sig}.txt`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, body);
  return { file, sig };
}

function versionAtLeast(v, major, minor, patch) {
  const p = String(v || '').split('.').map(n => parseInt(n, 10) || 0);
  const [a, b, c] = [p[0] || 0, p[1] || 0, p[2] || 0];
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}
// 1.13.4 accepts the config and silently returns an empty transcript for every
// streaming transducer — the page must say so rather than look "broken".
const transducerOk = () => versionAtLeast(sherpaVersion, 1, 13, 8);

const ENGINES = {
  cloud: { label: '在线 Whisper（OpenAI 兼容接口）', kind: 'cloud', hotwords: true },
  sense: { label: 'SenseVoiceSmall（当前默认）', kind: 'offline', hotwords: false },
  bi: { label: 'Zipformer 双语 2023（greedy，无热词）', kind: 'online', hotwords: false },
  'bi-hw': { label: 'Zipformer 双语 + 解码期热词', kind: 'online', hotwords: true, base: 'bi' },
  'zh25-hw': { label: 'Zipformer 中文 2025 + 热词（无英文词表）', kind: 'online', hotwords: true, base: 'zh25' },
  mul: { label: 'Zipformer 多语种 2025（无热词）', kind: 'online', hotwords: false },
};

let sensePost = null;
function applySensePost(text) {
  if (sensePost === null) {
    try {
      const asr = require(path.join(__dirname, '..', '..', 'src', 'voice', 'asr-local'));
      sensePost = asr && typeof asr.applyVocabCorrections === 'function' ? asr.applyVocabCorrections : false;
    } catch (_) { sensePost = false; }
  }
  return sensePost ? sensePost(text) : text;
}

// ── 在线 ASR（OpenAI 兼容 /audio/transcriptions）──
function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// Whisper has no decode-time biasing: the hotword list can only ride along as
// the `prompt`, which is a soft hint the model may ignore. Say so in the UI.
async function transcribeCloud(samples, { prompt, baseUrl, model, key, language }) {
  const url = String(baseUrl || CLOUD.baseUrl).replace(/\/+$/, '') + '/audio/transcriptions';
  const token = key || CLOUD.key;
  if (!token) throw new Error('未配置在线 key（页面里填一个，或在 .env 里设 WHISPER_API_KEY）');
  const form = new FormData();
  form.append('file', new Blob([encodeWav(samples, 16000)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model || CLOUD.model);
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', String(prompt).slice(0, 800));
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(45000),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`在线 ASR ${resp.status}: ${body.slice(0, 180)}`);
  let text = '';
  try { text = String(JSON.parse(body).text || '').trim(); }
  catch (_) { throw new Error(`在线 ASR 返回非 JSON: ${body.slice(0, 120)}`); }
  return { text, ms: Date.now() - t0 };
}

function hotwordPrompt(text) {
  const words = String(text || '').split(/\r?\n/).map(w => w.trim()).filter(Boolean);
  return words.length ? words.join(', ') : '';
}

async function runEngines(buf, { engines, hotwords, score, postProcess, cloud }) {
  const samples = await decodeAudio(buf);
  const audioSec = samples.length / 16000;
  const jobs = engines.map(async id => {
    const spec = ENGINES[id];
    if (!spec) return { id, error: '未知引擎' };
    const base = spec.base || id;
    if (!hasModel(base)) return { id, label: spec.label, error: '模型未下载' };
    try {
      if (spec.kind === 'cloud') {
        const prompt = hotwordPrompt(hotwords);
        const r = await transcribeCloud(samples, {
          prompt,
          baseUrl: cloud && cloud.baseUrl,
          model: cloud && cloud.model,
          key: cloud && cloud.key,
          language: (cloud && cloud.language) || CLOUD.language,
        });
        return {
          id, label: spec.label, text: r.text, ms: r.ms,
          hotwordsUsed: !!prompt,
          note: prompt ? '热词只作为 Whisper prompt 提示，不是解码期偏置' : undefined,
        };
      }
      const hw = spec.hotwords ? hotwordFileFor(base, hotwords, score) : null;
      const rec = getRecognizer(base, hw ? { hotwordsFile: hw.file, hotwordSig: `${hw.sig}|${score}`, hotwordsScore: score, maxActivePaths: 4 } : {});
      const r = spec.kind === 'offline' ? transcribeOffline(rec, samples) : transcribeOnline(rec, samples);
      let text = r.text;
      if (id === 'sense' && postProcess) text = applySensePost(text);
      return { id, label: spec.label, text, ms: r.ms, ctx: r.ctx, hotwordsUsed: !!hw, note: spec.hotwords && !hw ? '热词为空或该模型不支持' : undefined };
    } catch (e) {
      return { id, label: spec.label, error: e.message };
    }
  });
  return { audioSec, results: await Promise.all(jobs) };
}

// ── app hotwords (best effort) ──
function appHotwords() {
  try {
    const { hotwordList } = require(path.join(__dirname, '..', '..', 'src', 'voice', 'config'));
    return hotwordList() || '';
  } catch (_) { return ''; }
}

// ── http ──
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('音频过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const PAGE = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/status') {
      try { loadSherpa(); } catch (_) {}
      return send(res, 200, {
        sherpaVersion,
        sherpaError,
        transducerOk: transducerOk(),
        modelRoot: MODEL_ROOT,
        models: Object.fromEntries(Object.keys(DIRS).map(k => [k, hasModel(k)])),
        engines: ENGINES,
        hotwords: appHotwords(),
        // Never send the key to the page — only whether one exists.
        cloud: {
          baseUrl: CLOUD.baseUrl,
          model: CLOUD.model,
          language: CLOUD.language,
          hasKey: !!CLOUD.key,
          envFile: ENV_FILE,
        },
      });
    }
    // Preload the models the page has checked, so the first recording is not a
    // 10s model-load stall. Safe to call repeatedly.
    if (url.pathname === '/api/warm' && req.method === 'POST') {
      const ids = String(req.headers['x-engines'] || '').split(',').map(s => s.trim()).filter(Boolean);
      const loaded = [];
      for (const id of ids) {
        const spec = ENGINES[id];
        if (!spec) continue;
        // A hotword recognizer is built for one specific hotword signature, so
        // preloading the plain variant would only waste ~500MB.
        if (spec.hotwords || spec.kind === 'cloud') continue;
        const base = spec.base || id;
        if (!hasModel(base)) continue;
        try {
          getRecognizer(base, {});
          loaded.push(id);
        } catch (e) { /* reported through /api/transcribe */ }
      }
      return send(res, 200, { loaded });
    }
    if (url.pathname === '/api/transcribe' && req.method === 'POST') {
      const buf = await readBody(req);
      if (!buf.length) return send(res, 400, { error: '空音频' });
      const engines = String(req.headers['x-engines'] || 'sense,bi,bi-hw').split(',').map(s => s.trim()).filter(Boolean);
      const score = Number(req.headers['x-hotword-score'] || 3) || 3;
      const postProcess = String(req.headers['x-post-process'] || '1') !== '0';
      let hotwords = '';
      if (req.headers['x-hotwords']) {
        try { hotwords = Buffer.from(String(req.headers['x-hotwords']), 'base64').toString('utf8'); } catch (_) {}
      }
      // Per-recording online ASR override: {baseUrl, model, key, language}.
      let cloud = null;
      if (req.headers['x-cloud-config']) {
        try {
          const cfg = JSON.parse(Buffer.from(String(req.headers['x-cloud-config']), 'base64').toString('utf8'));
          if (cfg && typeof cfg === 'object') cloud = {
            baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
            model: typeof cfg.model === 'string' ? cfg.model : undefined,
            key: typeof cfg.key === 'string' && cfg.key && !cfg.key.includes('****') ? cfg.key : undefined,
            language: typeof cfg.language === 'string' ? cfg.language : undefined,
          };
        } catch (_) {}
      }
      const t0 = Date.now();
      const out = await runEngines(buf, { engines, hotwords, score, postProcess, cloud });
      return send(res, 200, { ...out, totalMs: Date.now() - t0 });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[asr-compare] http://${HOST}:${PORT}  (models: ${MODEL_ROOT})`);
  for (const k of Object.keys(DIRS)) console.log(`  ${hasModel(k) ? '✓' : '✗'} ${k}  ${dirOf(k)}`);
  console.log(`  ${CLOUD.key ? '✓' : '✗'} cloud  ${CLOUD.baseUrl} (${CLOUD.model})  env=${ENV_FILE}`);
});
