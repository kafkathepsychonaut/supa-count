// Renderer do widget: zero framework — recebe estado por IPC e desenha.

'use strict';

const { t } = window.__i18n;

let locale = 'pt-BR';
let limits = { dbLimitGb: 8, storageLimitGb: 100, mauLimit: 100000 };
let last = null;
let nextAt = 0;
let isConfigured = false;
let breaker = false;

const $ = (id) => document.getElementById(id);

function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} kB`;
  return `${b} B`;
}
function pctClass(p) {
  return p >= 90 ? 'danger' : p >= 70 ? 'warn' : '';
}

function row(label, valText, pct) {
  const safePct = Math.max(0, Math.min(100, pct ?? 0));
  return `<div class="row">
    <div class="head"><span class="label">${label}</span><span class="val">${valText}</span></div>
    <div class="bar"><i class="${pctClass(safePct)}" style="width:${safePct}%"></i></div>
  </div>`;
}
function mini(k, v) {
  return `<div class="mini"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function render() {
  const rows = $('rows');
  const grid = $('miniGrid');
  const msg = $('msg');
  msg.className = '';
  msg.textContent = '';

  if (!isConfigured) {
    rows.innerHTML = '';
    grid.innerHTML = '';
    msg.textContent = t(locale, 'notConfigured');
    msg.className = 'show';
    reportHeight();
    return;
  }
  if (!last) {
    rows.innerHTML = '';
    grid.innerHTML = '';
    msg.textContent = t(locale, 'loading');
    msg.className = 'show';
    reportHeight();
    return;
  }

  const s = last.sql;
  const dbPct = (s.dbBytes / (limits.dbLimitGb * 1e9)) * 100;
  const stPct = (s.storageBytes / (limits.storageLimitGb * 1e9)) * 100;
  const mauPct = (s.mauMonth / limits.mauLimit) * 100;

  let html = '';
  html += row(t(locale, 'db'), `${fmtBytes(s.dbBytes)} / ${limits.dbLimitGb} GB · ${dbPct.toFixed(1)}%`, dbPct);

  const infra = last.infra && !last.infra.error ? last.infra : null;
  if (infra && infra.diskSizeBytes) {
    const dkPct = (infra.diskUsedBytes / infra.diskSizeBytes) * 100;
    html += row(t(locale, 'disk'), `${fmtBytes(infra.diskUsedBytes)} / ${fmtBytes(infra.diskSizeBytes)} · ${dkPct.toFixed(0)}%`, dkPct);
  }
  html += row(t(locale, 'storage'), `${fmtBytes(s.storageBytes)} / ${limits.storageLimitGb} GB · ${stPct.toFixed(2)}%`, stPct);
  html += row(t(locale, 'mau'), `${s.mauMonth} / ${limits.mauLimit.toLocaleString(locale)} · ${mauPct.toFixed(2)}%`, mauPct);
  rows.innerHTML = html;

  let minis = '';
  minis += mini(t(locale, 'users'), String(s.totalUsers));
  minis += mini(t(locale, 'conn'), String(s.activeConnections));
  if (infra && infra.memTotalBytes) {
    const ramPct = Math.round((infra.memUsedBytes / infra.memTotalBytes) * 100);
    minis += mini(t(locale, 'ram'), `${ramPct}%`);
  } else if (infra && infra.load1 != null) {
    minis += mini(t(locale, 'load'), infra.load1.toFixed(2));
  } else {
    minis += mini(t(locale, 'load'), '—');
  }
  grid.innerHTML = minis;

  if (last.infra && last.infra.error) {
    msg.textContent = t(locale, 'infraOff');
    msg.className = 'show';
  }
  $('updatedAt').textContent = `${t(locale, 'updated')} ${new Date(last.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
  reportHeight();
}

function reportHeight() {
  requestAnimationFrame(() => {
    const h = document.getElementById('card').offsetHeight + 22; // padding da sombra
    window.supa.setHeight(h);
  });
}

// countdown do próximo refresh
setInterval(() => {
  const el = $('countdown');
  if (!nextAt || breaker) {
    el.textContent = breaker ? '⏸' : '';
    return;
  }
  const ms = nextAt - Date.now();
  if (ms <= 0) {
    el.textContent = t(locale, 'now');
    return;
  }
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  el.textContent = `${t(locale, 'nextIn')} ${min}:${String(sec).padStart(2, '0')}`;
}, 1000);

window.supa.onInit((p) => {
  locale = p.locale || 'pt-BR';
  limits = p.limits || limits;
  isConfigured = p.configured;
  document.body.className = p.theme === 'light' ? 'theme-light' : '';
  $('projName').textContent = p.projectName ? `· ${p.projectName}` : '';
  render();
});
window.supa.onUsage((p) => {
  last = p;
  nextAt = p ? p.nextAt : 0;
  $('dot').className = '';
  render();
});
window.supa.onError((e) => {
  $('dot').className = 'err';
  const msg = $('msg');
  msg.textContent = `${e.message}${e.status ? ` (${e.status})` : ''}`;
  msg.className = 'show err';
  reportHeight();
});
window.supa.onLoading((v) => {
  $('dot').className = v ? 'loading' : ($('dot').className === 'err' ? 'err' : '');
});
window.supa.onBreaker((v) => {
  breaker = v;
  if (v) {
    const msg = $('msg');
    msg.textContent = t(locale, 'breaker');
    msg.className = 'show err';
    reportHeight();
  }
});

$('btnRefresh').addEventListener('click', () => window.supa.refresh());
$('btnSettings').addEventListener('click', () => window.supa.openSettings());
$('btnHide').addEventListener('click', () => window.supa.hide());
