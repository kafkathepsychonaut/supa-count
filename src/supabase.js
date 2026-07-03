// Data source do Supa Count: duas fontes por refresh, ambas oficiais.
//
//  1. Management API `POST /v1/projects/{ref}/database/query` (PAT `sbp_...`):
//     UMA query SQL consolidada → db size, storage, users, MAU, conexões.
//     Rate limit oficial: 120 req/min — um refresh a cada minutos usa ~nada.
//  2. Endpoint privilegiado de métricas do projeto (Prometheus, basic auth
//     `service_role:<service key>`): disco real, RAM, load. Documentado em
//     supabase.com/docs/guides/telemetry/metrics (mesmo do supabase-grafana).
//     Refresh do lado deles é 1/min — não faz sentido scrape mais rápido.
//
// Erros tipados por propriedade (e.status, e.rateLimited, e.retryAfter) —
// o poller do main decide a cadência a partir disso (padrão count-claudula).

'use strict';

const SQL = `select
  pg_database_size(current_database()) as db_bytes,
  (select coalesce(sum((metadata->>'size')::bigint),0) from storage.objects) as storage_bytes,
  (select count(*) from auth.users) as total_users,
  (select count(distinct id) from auth.users where last_sign_in_at >= date_trunc('month', now())) as mau_month,
  (select count(*) from pg_stat_activity where state = 'active') as active_connections`;

const TIMEOUT_MS = 20_000;

function typedError(message, props = {}) {
  const e = new Error(message);
  Object.assign(e, props);
  return e;
}

async function timedFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Fonte 1 — SQL consolidado via Management API. */
async function fetchSqlStats({ projectRef, managementToken }) {
  const res = await timedFetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${managementToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: SQL }),
  });
  if (res.status === 429) {
    throw typedError('rate limited', {
      status: 429,
      rateLimited: true,
      retryAfter: Number(res.headers.get('retry-after')) || null,
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw typedError('token inválido ou sem permissão', { status: res.status, expired: true });
  }
  if (!res.ok) throw typedError(`management api ${res.status}`, { status: res.status });
  const rows = await res.json();
  const r = Array.isArray(rows) ? rows[0] : rows;
  if (!r || r.db_bytes === undefined) throw typedError('resposta inesperada do SQL', { status: 500 });
  return {
    dbBytes: Number(r.db_bytes),
    storageBytes: Number(r.storage_bytes),
    totalUsers: Number(r.total_users),
    mauMonth: Number(r.mau_month),
    activeConnections: Number(r.active_connections),
  };
}

/** Parser mínimo de Prometheus text format: name{labels} value */
function parseProm(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const head = line.slice(0, sp);
    const value = Number(line.slice(sp + 1));
    if (!Number.isFinite(value)) continue;
    const brace = head.indexOf('{');
    const name = brace < 0 ? head : head.slice(0, brace);
    const labels = {};
    if (brace >= 0) {
      const inner = head.slice(brace + 1, head.lastIndexOf('}'));
      for (const m of inner.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[m[1]] = m[2];
    }
    out.push({ name, labels, value });
  }
  return out;
}

const pick = (ms, name, match = () => true) => ms.find((m) => m.name === name && match(m.labels))?.value ?? null;

/** Fonte 2 — métricas de infra (disco/RAM/load) do endpoint privilegiado. */
async function fetchInfraMetrics({ projectRef, serviceRoleKey }) {
  const auth = Buffer.from(`service_role:${serviceRoleKey}`).toString('base64');
  const res = await timedFetch(`https://${projectRef}.supabase.co/customer/v1/privileged/metrics`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw typedError('service key inválida pro endpoint de métricas', { status: res.status, expired: true });
  }
  if (!res.ok) throw typedError(`metrics ${res.status}`, { status: res.status });
  const ms = parseProm(await res.text());
  const isData = (l) => l.mountpoint === '/data';
  const diskAvail = pick(ms, 'node_filesystem_avail_bytes', isData);
  const diskSize = pick(ms, 'node_filesystem_size_bytes', isData);
  const memAvail = pick(ms, 'node_memory_MemAvailable_bytes');
  const memTotal = pick(ms, 'node_memory_MemTotal_bytes');
  const load1 = pick(ms, 'node_load1');
  const cpus = ms.filter((m) => m.name === 'node_cpu_online' && m.value === 1).length || null;
  return {
    diskUsedBytes: diskSize != null && diskAvail != null ? diskSize - diskAvail : null,
    diskSizeBytes: diskSize,
    memUsedBytes: memTotal != null && memAvail != null ? memTotal - memAvail : null,
    memTotalBytes: memTotal,
    load1,
    cpus,
  };
}

/** Um refresh completo. `serviceRoleKey` é opcional (sem ela, sem infra). */
async function fetchAll(cfg) {
  const sql = await fetchSqlStats(cfg);
  let infra = null;
  if (cfg.serviceRoleKey) {
    try {
      infra = await fetchInfraMetrics(cfg);
    } catch (e) {
      // Infra é bônus: falha aqui não derruba o refresh — o widget mostra o
      // que tem e marca a linha de infra como indisponível.
      infra = { error: e.message };
    }
  }
  return { at: Date.now(), sql, infra };
}

module.exports = { fetchAll, fetchSqlStats, fetchInfraMetrics, parseProm };

// Smoke test fora do Electron: SUPA_REF=... SUPA_PAT=... SUPA_SRK=... node src/supabase.js
if (require.main === module) {
  const cfg = {
    projectRef: process.env.SUPA_REF,
    managementToken: process.env.SUPA_PAT,
    serviceRoleKey: process.env.SUPA_SRK || null,
  };
  if (!cfg.projectRef || !cfg.managementToken) {
    console.error('faltam SUPA_REF / SUPA_PAT no env');
    process.exit(1);
  }
  fetchAll(cfg).then(
    (r) => console.log(JSON.stringify(r, null, 2)),
    (e) => {
      console.error('ERRO:', e.message, e.status ?? '');
      process.exit(1);
    },
  );
}
