'use strict';

const FIELDS = [
  'projectRef', 'projectName', 'managementToken', 'serviceRoleKey',
  'dbLimitGb', 'storageLimitGb', 'mauLimit', 'refreshSec', 'theme', 'locale',
];
const NUMERIC = new Set(['dbLimitGb', 'storageLimitGb', 'mauLimit', 'refreshSec']);

const $ = (id) => document.getElementById(id);

window.supa.settingsGet().then((cfg) => {
  for (const f of FIELDS) {
    if ($(f) && cfg[f] !== undefined && cfg[f] !== null) $(f).value = cfg[f];
  }
});

$('save').addEventListener('click', async () => {
  const next = {};
  for (const f of FIELDS) {
    const raw = $(f).value.trim();
    next[f] = NUMERIC.has(f) ? Number(raw) || 0 : raw;
  }
  if (next.refreshSec < 60) next.refreshSec = 60; // respeita rate limit com folga
  await window.supa.settingsSet(next);
  $('saved').textContent = 'salvo ✓';
  setTimeout(() => ($('saved').textContent = ''), 2000);
});
