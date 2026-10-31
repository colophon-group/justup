'use strict';
// Only publisher-provided signals; no simulated hiring statistics.
function renderHiringWire(signals = []) {
  const items = signals.filter(item => typeof item.text === 'string' && item.text.trim());
  $('#hiring-wire').hidden = !items.length;
  $('#wire-track').replaceChildren();
  if (!items.length) return;
  const copy = items.map(item => `<span class="wire-item">${escapeHTML(item.text)}</span>`).join('<span aria-hidden="true"> · </span>');
  $('#wire-track').innerHTML = `<div class="wire-group">${copy}</div><div class="wire-group" aria-hidden="true">${copy}</div>`;
}
