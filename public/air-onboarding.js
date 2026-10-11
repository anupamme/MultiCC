'use strict';

(function (root) {
  const $ = id => document.getElementById(id);
  let dismissed = false;
  try { dismissed = localStorage.getItem('air:setup-dismissed') === 'true'; } catch (_) {}
  let context;
  function render(next) {
    context = next;
    if (!next.data) return;
    const { data, auxConfigured, setMode } = next;
    const done = [auxConfigured === true, data.directories.length > 0, data.tasks.length > 0];
    const count = done.filter(Boolean).length;
    const incomplete = count < 3 && auxConfigured !== null;
    $('setup-card').hidden = !incomplete || dismissed;
    $('onboarding-entry').hidden = !incomplete;
    $('onboarding-progress').textContent = count + ' / 3';
    $('setup-progress').value = count;
    $('setup-progress').setAttribute('aria-valuetext', count + ' / 3');
    const current = done.indexOf(false);
    for (let i = 0; i < 3; i++) {
      const step = $('setup-step-' + i);
      step.classList.toggle('done', done[i]);
      step.classList.toggle('current', i === current);
      step.classList.toggle('upcoming', !done[i] && i !== current);
      step.querySelector('.setup-number').textContent = done[i] ? '✓' : String(i + 1);
      if (i === current) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    }
    $('setup-first-task').disabled = !done[0] || !done[1];
    $('setup-provider').onclick = () => setMode('provider');
    $('setup-aux').onclick = () => setMode('aux');
    $('setup-project').onclick = () => $('add-directory').click();
    $('setup-example').onclick = next.example;
    $('setup-first-task').onclick = () => $('create').click();
    $('setup-dismiss').onclick = () => {
      dismissed = true;
      try { localStorage.setItem('air:setup-dismissed', 'true'); } catch (_) {}
      render(context);
    };
    $('onboarding-entry').onclick = () => {
      dismissed = false;
      try { localStorage.removeItem('air:setup-dismissed'); } catch (_) {}
      setMode('overview'); render(context);
      $('setup-card').scrollIntoView({ block: 'start' });
    };
  }
  root.MultiCCAirOnboarding = { render };
})(window);
