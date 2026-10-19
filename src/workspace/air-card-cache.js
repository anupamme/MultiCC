'use strict';

// /api/air 的卡片底稿缓存。
//
// 线上约 1270 张卡片，每一轮都要逐卡解析权属、资源、待处理提醒 —— 而 7 成以上的
// 轮次最后回的是 304，这些活全白干。这里只缓存「卡片底稿」：内容完全由输入决定的
// 那部分。随时间或运行时自己变的两格（runState 的派发宽限、worktree 的 Git 状态）
// 不进缓存，由调用方每轮现算叠上去，所以缓存里没有任何会「到点过期」的东西。
//
// 命中的唯一依据是调用方给出的签名：签名由输入内容本身算出（不是某个可能漏写的
// 版本号），签名相同就说明底稿的输入没变。为了把「签名漏了某个输入」这种错误找
// 出来而不是让它沉默，有三档：
//   off    —— 永远现建，不比对。
//   shadow —— 永远现建并照常返回；签名没变时把新建结果与上一份比对，记下差异。
//             默认档：它不省 CPU，只证明签名是全的。
//   on     —— 签名没变就直接用缓存；但同一份缓存最多用 verifyMs，到点照样现建
//             一次并比对，所以即便签名真漏了输入，陈旧也有上限，而且会留下日志。
const MODES = new Set(['off', 'shadow', 'on']);

function createAirCardCache({ mode = 'shadow', verifyMs = 60_000, reportMs = 10 * 60_000, logger = null,
  clock = Date.now } = {}) {
  const active = MODES.has(mode) ? mode : 'shadow';
  let held = null; // { signature, bases, body, builtAt }
  const stats = { hits: 0, misses: 0, verifies: 0, mismatches: 0 };
  let lastReportAt = clock(), lastMismatchLogAt = 0;

  // 比对按序列化后的底稿做：输出也是这么序列化的，判据与客户端看到的完全一致。
  const bodyOf = bases => JSON.stringify(bases.map(entry => entry.card));
  function firstDifference(before, after) {
    const previous = new Map(before.map(entry => [entry.card.id, entry.card]));
    if (before.length !== after.length) return { count: [before.length, after.length] };
    for (const entry of after) {
      const old = previous.get(entry.card.id);
      if (!old) return { taskId: entry.card.id, fields: ['<new card>'] };
      const fields = Object.keys(entry.card).filter(key => JSON.stringify(old[key]) !== JSON.stringify(entry.card[key]));
      if (fields.length) return { taskId: entry.card.id, fields };
    }
    return { order: true };
  }
  function compare(bases, body) {
    stats.verifies += 1;
    if (body === held.body) return;
    stats.mismatches += 1;
    const now = clock();
    if (!logger || now - lastMismatchLogAt < 60_000) return;
    lastMismatchLogAt = now;
    try { logger.warn('air_card_cache_mismatch', { mode: active, ...firstDifference(held.bases, bases) }); } catch (_) {}
  }
  function report() {
    const now = clock();
    if (!logger || now - lastReportAt < reportMs) return;
    lastReportAt = now;
    try { (logger.info || logger.log || logger.warn).call(logger, 'air_card_cache_stats', { mode: active, ...stats }); } catch (_) {}
  }

  // signature 为 null 表示「这一轮说不清输入有没有变」（例如任务库读数拿不到）：
  // 一律现建，并丢掉手上的缓存。返回 { bases, outcome }，outcome 只进计时日志。
  function resolve(signature, build) {
    report();
    if (active === 'off' || signature == null) {
      held = null; stats.misses += 1;
      return { bases: build(), outcome: 'bypass' };
    }
    const now = clock();
    const same = held && held.signature === signature;
    if (active === 'on' && same && now - held.builtAt < verifyMs) {
      stats.hits += 1;
      return { bases: held.bases, outcome: 'hit' };
    }
    const bases = build();
    const body = bodyOf(bases);
    let outcome = 'miss';
    if (same) { compare(bases, body); outcome = 'verify'; } else stats.misses += 1;
    held = { signature, bases, body, builtAt: now };
    return { bases, outcome };
  }

  return { resolve, mode: active, stats: () => ({ mode: active, ...stats }) };
}

module.exports = { createAirCardCache, AIR_CARD_CACHE_MODES: MODES };
