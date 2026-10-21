'use strict';

const { taskStatus } = require('../../public/status-presentation');
const clone = value => JSON.parse(JSON.stringify(value));
const at = task => task.lastMessageAt || task.updatedAt || 0;
const compare = (a, b) => at(b) - at(a) || a.id.localeCompare(b.id);
const zero = () => ({ total: 0, open: 0, running: 0, needs: 0, todo: 0, error: 0, archived: 0 });

// 与 Rust 相同的算法：Map + 有序数组、逐行失效、计数增减、大批量才排序。
class IncrementalModel {
  constructor() { this.reset(); }
  reset() { this.rows = new Map(); this.order = []; this.counts = {}; this.metadata = null; this.memo = new Map(); }
  needs(t) { return t.status !== 'archived' && !this.ignored.has(t.id)
    && (this.todos.has(t.id) || ['waiting', 'error'].includes(taskStatus(t))
      || (taskStatus(t) === 'succeeded' && t.goalState === 'interact')); }
  count(t, delta) {
    const state = taskStatus(t);
    for (const key of ['all', t.dirId]) {
      const c = this.counts[key] ||= zero();
      const values = { total: 1, open: !['done', 'archived'].includes(t.status), running: state === 'running',
        needs: this.needs(t), todo: t.status !== 'archived' && this.todos.has(t.id), error: state === 'error', archived: t.status === 'archived' };
      for (const key of Object.keys(values)) c[key] += Number(values[key]) * delta;
      if (c.total === 0) delete this.counts[key];
    }
  }
  apply(tasks, { reset = false, removed = [], metadata } = {}) {
    if (reset) this.reset();
    const metaChanged = JSON.stringify(metadata) !== JSON.stringify(this.metadata);
    if (metaChanged) {
      this.metadata = clone(metadata); this.todos = new Set(metadata.taskTodos);
      this.ignored = new Set(metadata.taskTodoIgnored);
    }
    const changed = [], deleted = [];
    for (const id of removed) {
      const old = this.rows.get(id); if (!old) continue;
      if (!metaChanged) this.count(old.card, -1);
      this.rows.delete(id); deleted.push(id);
    }
    for (const card of tasks) {
      const body = JSON.stringify(card), old = this.rows.get(card.id);
      if (old?.body === body) continue;
      if (old && !metaChanged) this.count(old.card, -1);
      const detached = JSON.parse(body); this.rows.set(card.id, { card: detached, body });
      if (!metaChanged) this.count(detached, 1);
      changed.push(card.id);
    }
    if (metaChanged) { this.counts = {}; for (const { card } of this.rows.values()) this.count(card, 1); }
    if (reset || changed.length + deleted.length > this.rows.size / 8) {
      this.order = [...this.rows.values()].map(row => row.card).sort(compare);
    } else {
      const dirty = new Set([...changed, ...deleted]); this.order = this.order.filter(t => !dirty.has(t.id));
      for (const id of changed) {
        const card = this.rows.get(id).card; let lo = 0, hi = this.order.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (compare(this.order[mid], card) < 0) lo = mid + 1; else hi = mid; }
        this.order.splice(lo, 0, card);
      }
    }
    if (reset || metaChanged || changed.length || deleted.length) this.memo.clear();
    return { changed: changed.length, deleted: deleted.length, total: this.rows.size };
  }
  page(options = {}) {
    const key = JSON.stringify(options); if (this.memo.has(key)) return this.memo.get(key);
    const filter = options.status || 'open', needle = (options.query || '').toLowerCase();
    const dirs = new Map(this.metadata.directories.map(d => [d.id, d.name]));
    const pins = new Map(this.metadata.taskPins.map((id, i) => [id, i]));
    const rank = options.ids && new Map(options.ids.map((id, i) => [id, i]));
    let list = this.order.filter(t => {
      if (options.dirId && options.dirId !== t.dirId || rank && !rank.has(t.id)) return false;
      if (needle && !`${t.title} ${dirs.get(t.dirId) || ''}`.toLowerCase().includes(needle)) return false;
      const state = taskStatus(t);
      if (filter === 'all') return true;
      if (filter === 'recent') return t.status !== 'archived';
      if (filter === 'archived') return t.status === 'archived';
      if (filter === 'today') return (state === 'succeeded' || t.status === 'done') && t.updatedAt >= (options.dayStart || 0);
      if (['needs', 'waiting'].includes(filter)) return this.needs(t);
      if (filter === 'waitingReply') return state === 'waiting';
      if (filter === 'todo') return t.status !== 'archived' && this.todos.has(t.id);
      if (['achieved', 'interact'].includes(filter)) return state === 'succeeded' && t.goalState === filter;
      if (['running', 'error', 'succeeded'].includes(filter)) return state === filter;
      return !['done', 'archived'].includes(t.status);
    });
    const direction = options.sort === 'oldest' || ['needs', 'todo', 'waiting'].includes(filter) ? 1 : -1;
    list.sort((a, b) => rank ? rank.get(a.id) - rank.get(b.id)
      : pins.has(a.id) || pins.has(b.id) ? (pins.get(a.id) ?? Infinity) - (pins.get(b.id) ?? Infinity)
        : (options.sort === 'visit' ? direction * ((options.visits?.[a.id] || 0) - (options.visits?.[b.id] || 0)) : 0)
          || direction * (at(a) - at(b)) || a.id.localeCompare(b.id));
    const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 20)));
    const pages = Math.max(1, Math.ceil(list.length / limit)), page = Math.max(1, Math.min(pages, Math.floor(Number(options.page) || 1)));
    const result = { ok: true, page, pages, total: list.length, tasks: list.slice((page - 1) * limit, page * limit) };
    if (this.memo.size >= 128) this.memo.delete(this.memo.keys().next().value);
    this.memo.set(key, result); return result;
  }
  stats(dayStart = 0) {
    const counts = clone(this.counts);
    for (const { card: t } of this.rows.values()) if ((taskStatus(t) === 'succeeded' || t.status === 'done') && t.updatedAt >= dayStart) {
      for (const key of ['all', t.dirId]) counts[key].today = (counts[key].today || 0) + 1;
    }
    return counts;
  }
}
module.exports = { IncrementalModel };
