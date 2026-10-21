'use strict';

(function (root) {
  const cache = new Map();
  const pending = new Map();
  const tr = (key, params) => root.t(key, params);
  const date = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    return new Date(value).toLocaleDateString();
  };

  function summary(value) {
    const renewal = date(value?.nextBillingAt);
    const end = date(value?.currentPeriodEnd);
    if (value?.autoRenew === false) return tr(end ? 'subscriptionCancelledUntil' : 'subscriptionCancelled', { date: end });
    if (renewal) return tr(value.nextBillingAt > Date.now() ? 'subscriptionNextBilling' : 'subscriptionLastBilling', { date: renewal });
    if (end) return tr('subscriptionPeriodEnd', { date: end });
    return tr('subscriptionUnknown');
  }

  function mount(host, { vendor, accountId, subscription, api }) {
    if (!host || !['claude', 'codex'].includes(vendor)) return;
    const id = accountId === 'global' ? '' : accountId || '';
    const key = `${vendor}:${id}`;
    const label = document.createElement('span');
    const refresh = document.createElement('button'); refresh.type = 'button';
    refresh.textContent = tr('subscriptionRefresh');
    const billing = document.createElement('a');
    billing.href = vendor === 'codex' ? 'https://chatgpt.com/#settings/Account' : 'https://claude.ai/settings/billing';
    billing.target = '_blank'; billing.rel = 'noopener noreferrer'; billing.textContent = tr('subscriptionOpenBilling');
    host.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;color:var(--muted);line-height:1.6';
    refresh.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid var(--border);border-radius:6px;padding:2px 8px;cursor:pointer';
    billing.style.color = 'inherit';
    billing.title = tr('subscriptionBillingAccountHint');
    host.replaceChildren(label, refresh, billing);

    function paint(result) {
      const value = result?.status === 'ok' ? result.subscription : result?.subscription || subscription;
      label.textContent = summary(value);
      if (result?.status === 'no_auth') label.textContent = tr('subscriptionLoginRequired');
      else if (result?.status === 'unavailable') label.textContent = value
        ? `${label.textContent} · ${tr('subscriptionFetchFailed')}` : tr('subscriptionFetchFailed');
      label.title = value?.source === 'login' ? tr('subscriptionLoginSnapshot') : tr('subscriptionDateHint');
      if (value?.observedAt) label.title += ` · ${new Date(value.observedAt).toLocaleString()}`;
    }

    async function load(force) {
      const saved = cache.get(key);
      if (!force && saved && Date.now() - saved.at < 300000) { paint(saved.result); return; }
      refresh.disabled = true;
      refresh.textContent = tr('subscriptionLoading');
      try {
        if (!pending.has(key)) {
          const path = `/api/${vendor}/subscription${id ? `?account=${encodeURIComponent(id)}` : ''}`;
          pending.set(key, Promise.resolve().then(() => api(path))
            .catch(() => ({ status: 'unavailable' }))
            .then(result => { cache.set(key, { result, at: Date.now() }); return result; })
            .finally(() => pending.delete(key)));
        }
        const result = await pending.get(key);
        paint(result);
      } finally { refresh.disabled = false; refresh.textContent = tr('subscriptionRefresh'); }
    }
    paint(cache.get(key)?.result);
    refresh.onclick = () => { void load(true); };
    void load(false);
  }

  root.MultiCCProviderSubscription = Object.freeze({ mount, summary });
})(window);
