'use strict';

// The settings page reuses the original power and host controls. Parking them
// before replacing page content preserves listeners and in-flight operations.
(function (root) {
  const ids = ['settings-power-controls', 'settings-host-controls'];
  function park() {
    const pool = document.getElementById('settings-control-pool');
    for (const id of ids) { const node = document.getElementById(id); if (node) pool.append(node); }
  }
  function mount(host) {
    for (const id of ['air-lid-sleep', 'air-auto-unlock']) {
      const button = document.getElementById(id);
      if (button.parentElement.classList.contains('power-setting-wrap')) continue;
      const wrap = document.createElement('div'); wrap.className = 'power-setting-wrap';
      button.before(wrap); wrap.append(button);
      const details = document.createElement('details'), summary = document.createElement('summary');
      summary.textContent = 'ⓘ'; summary.setAttribute('aria-label', button.querySelector('strong').textContent);
      const text = button.querySelector('small');
      details.append(summary, text); wrap.append(details);
    }
    for (const id of ids) host.append(document.getElementById(id));
    root.dispatchEvent(new Event('multicc-more-opened'));
  }
  root.MultiCCAirMore = { park, mount,
    open: () => root.dispatchEvent(new Event('multicc-open-settings')), close() {} };
})(window);
