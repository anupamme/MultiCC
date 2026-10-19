'use strict';

// /api/air 的卡片底稿缓存（逐卡）。
//
// 线上约 1270 张卡片，每一轮都要逐卡解析权属、资源、待处理提醒 —— 而 7 成以上的
// 轮次最后回的是 304，这些活全白干。这里只缓存「卡片底稿」：内容完全由输入决定的
// 那部分。随时间或全局运行时变的几格（runState 的派发宽限、worktree 的 Git 状态、
// 依赖全局租约数的 capacityReason）不进缓存，由调用方每轮现算叠上去，所以缓存里
// 没有任何会「到点过期」的东西。
//
// 粒度必须是单张卡：任务板一次写入通常只动正在跑的那一张卡（线上实测几秒一次），
// 整份列表共用一个签名时，这一张卡就会让 1270 张一起重建，缓存几乎永远不命中。
// 签名分两层：全局签名（所有卡共同读到的输入，例如任务库读数）变了就全部重建；
// 每张卡自己的签名只覆盖它自己读到的输入。
//
// 签名由输入内容本身算出（不是某个可能漏写的版本号）。为了把「签名漏了某个输入」
// 这种错误找出来而不是让它沉默，有三档：
//   off    —— 永远现建，不比对。
//   shadow —— 永远现建并照常返回；签名没变的卡把新建结果与上一份比对，记下差异。
//             默认档：它不省 CPU，只证明签名是全的。
//   on     —— 签名没变就直接用缓存；但同一份底稿最多用约 verifyMs（逐卡错开，
//             避免整点齐刷），到点照样现建并比对，所以即便签名真漏了输入，陈旧也
//             有上限，而且会留下日志。
const MODES = new Set(['off', 'shadow', 'on']);

function createAirCardCache({ mode = 'shadow', verifyMs = 60_000, reportMs = 10 * 60_000, logger = null,
  clock = Date.now, random = Math.random } = {}) {
  const active = MODES.has(mode) ? mode : 'shadow';
  let global = null;
  let held = new Map(); // id -> { signature, entry, body, expiresAt }
  const stats = { requests: 0, hits: 0, builds: 0, verifies: 0, mismatches: 0, globalResets: 0 };
  let lastReportAt = clock(), lastMismatchLogAt = 0;

  // 比对按序列化后的底稿做：输出也是这么序列化的，判据与客户端看到的完全一致。
  const bodyOf = entry => JSON.stringify(entry.card);
  function mismatch(previous, entry) {
    stats.mismatches += 1;
    const now = clock();
    if (!logger || now - lastMismatchLogAt < 60_000) return;
    lastMismatchLogAt = now;
    const fields = Object.keys(entry.card)
      .filter(key => JSON.stringify(previous.entry.card[key]) !== JSON.stringify(entry.card[key]));
    try { logger.warn('air_card_cache_mismatch', { mode: active, taskId: entry.card.id, fields }); } catch (_) {}
  }
  function report() {
    const now = clock();
    if (!logger || now - lastReportAt < reportMs) return;
    lastReportAt = now;
    try { (logger.info || logger.log || logger.warn).call(logger, 'air_card_cache_stats', { mode: active, ...stats }); } catch (_) {}
  }

  // items: 本轮全部卡片（任意对象）；keyOf/signatureOf/build 由调用方给。
  // globalSignature 为 null 表示「这一轮说不清共同输入有没有变」（例如任务库读数
  // 拿不到）：一律现建，并丢掉手上的缓存。返回 { entries, hits, builds }。
  function resolve(globalSignature, items, { keyOf, signatureOf, build, prune = true, countRequest = true }) {
    if (countRequest) { report(); stats.requests += 1; }
    if (active === 'off' || globalSignature == null) {
      global = null; held = new Map();
      stats.builds += items.length;
      return { entries: items.map(build), hits: 0, builds: items.length };
    }
    if (globalSignature !== global) {
      if (global !== null) stats.globalResets += 1;
      global = globalSignature; held = new Map();
    }
    const now = clock();
    const next = prune ? new Map() : held;
    let hits = 0, builds = 0;
    const entries = items.map(item => {
      const key = keyOf(item), signature = signatureOf(item);
      const previous = held.get(key);
      const same = !!previous && previous.signature === signature;
      if (active === 'on' && same && now < previous.expiresAt) {
        hits += 1; next.set(key, previous);
        return previous.entry;
      }
      const entry = build(item);
      builds += 1;
      const body = active === 'shadow' || same ? bodyOf(entry) : null;
      if (same) { stats.verifies += 1; if (body !== previous.body) mismatch(previous, entry); }
      next.set(key, { signature, entry, body: body ?? bodyOf(entry),
        expiresAt: now + verifyMs * (0.5 + random() / 2) });
      return entry;
    });
    held = next;
    stats.hits += hits; stats.builds += builds;
    return { entries, hits, builds };
  }

  async function resolveAsync(globalSignature, items, options) {
    report(); stats.requests += 1;
    const entries = []; let hits = 0, builds = 0;
    for (let i = 0; i < items.length; i += 24) {
      const batch = resolve(globalSignature, items.slice(i, i + 24), { ...options, prune: false, countRequest: false });
      entries.push(...batch.entries); hits += batch.hits; builds += batch.builds;
      await new Promise(done => setImmediate(done));
    }
    if (options.prune !== false) {
      const keys = new Set(items.map(options.keyOf));
      for (const key of held.keys()) if (!keys.has(key)) held.delete(key);
    }
    return { entries, hits, builds };
  }
  return { resolve, resolveAsync, mode: active, stats: () => ({ mode: active, ...stats }) };
}

module.exports = { createAirCardCache, AIR_CARD_CACHE_MODES: MODES };
