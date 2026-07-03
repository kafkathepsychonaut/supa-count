// Renderer do widget: zero framework — recebe estado por IPC e desenha.

'use strict';

// Fallback defensivo: se o i18n não carregou, mostra as chaves cruas em vez de
// morrer silencioso (widget vazio sem erro).
const { t } = window.__i18n ?? { t: (_l, k) => k };

let locale = 'pt-BR';
let limits = { dbLimitGb: 8, storageLimitGb: 100, mauLimit: 100000 };
let last = null;
let nextAt = 0;
let isConfigured = false;
let breaker = false;
let updState = null; // banner de update: {state, version, percent}
let showDetail = (() => { try { return localStorage.getItem('supa-detail') === '1'; } catch { return false; } })();

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
  renderDetail();
  $('updatedAt').textContent = `${t(locale, 'updated')} ${new Date(last.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
  reportHeight();
}

// Banner de update (espelha a tray): available → clique baixa; downloading → %;
// ready → clique reinicia na versão nova. Idêntico ao count-claudula.
function renderUpdate() {
  document.body.classList.toggle('has-upd', !!updState);
  if (!updState) return;
  let label;
  if (updState.state === 'ready') label = t(locale, 'updateRestart');
  else if (updState.state === 'downloading') label = `${t(locale, 'updating')}${updState.percent ? ' ' + updState.percent + '%' : ''}`;
  else label = `${t(locale, 'updateDownload')}${updState.version ? ' · v' + updState.version : ''}`;
  $('updLabel').textContent = label;
}

// Visão detalhada expansível — mantém a básica intacta; aqui as métricas extras
// que o endpoint privilegiado + o SQL liberam. Diego 2026-07-03.
function drow(k, v) { return `<div class="drow"><span class="dk">${k}</span><span class="dv">${v}</span></div>`; }
function dsec(txt) { return `<div class="dsec">${txt}</div>`; }
function renderDetail() {
  const btn = $('moreBtn');
  const det = $('detail');
  const hasData = isConfigured && last;
  btn.style.display = hasData ? 'block' : 'none';
  document.body.classList.toggle('has-detail', hasData && showDetail);
  btn.textContent = showDetail ? `▲ ${t(locale, 'less')}` : `▼ ${t(locale, 'more')}`;
  if (!hasData || !showDetail) { det.innerHTML = ''; return; }
  const s = last.sql;
  const infra = last.infra && !last.infra.error ? last.infra : null;
  let h = '';
  h += dsec(t(locale, 'db'));
  if (s.cacheHitPct != null) h += drow('cache hit', `${s.cacheHitPct}%`);
  if (s.publicTables != null) h += drow('tabelas', String(s.publicTables));
  if (s.biggestTable) h += drow('maior tabela', `${s.biggestTable} · ${fmtBytes(s.biggestTableBytes)}`);
  h += dsec(t(locale, 'conn'));
  h += drow('ativas / idle / total', `${s.activeConnections} / ${s.idleConnections ?? '—'} / ${s.totalConnections ?? '—'}`);
  if (infra && infra.poolWaiting != null) h += drow('pool esperando', String(infra.poolWaiting));
  if (infra) {
    h += dsec('infra');
    if (infra.swapTotalBytes) {
      const sp = Math.round((infra.swapUsedBytes / infra.swapTotalBytes) * 100);
      h += drow('swap', `${fmtBytes(infra.swapUsedBytes)} / ${fmtBytes(infra.swapTotalBytes)} · ${sp}%`);
    }
    if (infra.memCachedBytes != null) h += drow('RAM cache', fmtBytes(infra.memCachedBytes));
    if (infra.load1 != null) h += drow('load 1/5/15', `${infra.load1.toFixed(2)} · ${(infra.load5 ?? 0).toFixed(2)} · ${(infra.load15 ?? 0).toFixed(2)}`);
    if (infra.cpus != null) h += drow('CPUs', String(infra.cpus));
  }
  det.innerHTML = h;
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
  renderUpdate();
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

window.supa.onUpdate((u) => {
  updState = u && u.state && u.state !== 'none' ? u : null;
  renderUpdate();
  reportHeight();
});

$('btnRefresh').addEventListener('click', () => window.supa.refresh());
$('btnSettings').addEventListener('click', () => window.supa.openSettings());
$('btnHide').addEventListener('click', () => window.supa.hide());
$('upd').addEventListener('click', () => {
  if (!updState) return;
  if (updState.state === 'ready') window.supa.updateRestart();
  else if (updState.state === 'available') window.supa.updateDownload();
});
$('moreBtn').addEventListener('click', () => {
  showDetail = !showDetail;
  try { localStorage.setItem('supa-detail', showDetail ? '1' : '0'); } catch { /* ignore */ }
  renderDetail();
  reportHeight();
});

// Listeners registrados — agora sim pede o estado ao main (handshake).
window.supa.ready();
