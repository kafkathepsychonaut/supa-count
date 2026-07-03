# supa-count

Desktop widget que monitora o usage do seu projeto **Supabase** em tempo (quase) real — irmão do [count-claudula](https://github.com/kafkathepsychonaut/count-claudula).

Mostra num card always-on-top:

- **banco** — `pg_database_size` vs. o limite do seu plano (barra com %)
- **disco real** — usado/total do volume `/data` (o disco que o Pro auto-escala)
- **storage** — bytes somados de `storage.objects` vs. limite do plano
- **MAU do mês** — usuários com login no mês corrente vs. limite
- **contas · conexões ativas · RAM** — minicards
- countdown do próximo refresh, refresh manual, tray, tema dark/light, pt-BR/en

## Fontes de dados (oficiais)

1. **Management API** `POST /v1/projects/{ref}/database/query` com seu Personal
   Access Token (`sbp_…`) — uma query SQL consolidada por refresh. Rate limit
   oficial: 120 req/min; o widget usa 1 req a cada N minutos.
2. **Endpoint privilegiado de métricas** (`https://<ref>.supabase.co/customer/v1/privileged/metrics`,
   formato Prometheus, basic auth `service_role`) — disco, RAM, load. É o mesmo
   endpoint documentado em [supabase.com/docs/guides/telemetry/metrics](https://supabase.com/docs/guides/telemetry/metrics)
   que o `supabase-grafana` oficial usa. Opcional: sem a service key, o widget
   só omite a linha de infra.

Polling educado: backoff exponencial em 429 (honra `Retry-After`), circuit
breaker após erros 4xx seguidos, pausa em suspend/lock da máquina.

## Segurança

Os tokens ficam **somente** em `config.json` no diretório de dados do app
(`%APPDATA%/Supa Count` no Windows) — nunca no repositório, nunca enviados a
lugar nenhum além de `api.supabase.com` e `<ref>.supabase.co`.

## Rodar

```bash
npm install
npm start
```

Na primeira abertura, a janela de configurações pede project ref + PAT
(+ service key opcional). Smoke test do fetcher sem Electron:

```bash
SUPA_REF=... SUPA_PAT=... SUPA_SRK=... npm run usage
```

## Build

```bash
npm run dist          # instalador + portable (Windows), dmg (macOS), AppImage (Linux)
```

MIT © Kafka Software
