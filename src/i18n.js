// i18n mínimo (pt-BR + en) — roda em main E renderer (CommonJS + window global).

'use strict';

const LOCALES = {
  'pt-BR': {
    db: 'banco',
    disk: 'disco',
    storage: 'storage',
    mau: 'MAU (mês)',
    users: 'contas',
    ram: 'RAM',
    conn: 'conexões',
    load: 'load',
    updated: 'atualizado',
    nextIn: 'próxima em',
    now: 'agora',
    loading: 'consultando…',
    notConfigured: 'configure o projeto pra começar',
    breaker: 'pausado após erros seguidos — clique em atualizar pra tentar de novo',
    showHide: 'mostrar/esconder',
    refreshNow: 'atualizar agora',
    settings: 'configurações',
    openDashboard: 'abrir dashboard do supabase',
    quit: 'sair',
    infraOff: 'infra indisponível (service key?)',
  },
  en: {
    db: 'database',
    disk: 'disk',
    storage: 'storage',
    mau: 'MAU (month)',
    users: 'accounts',
    ram: 'RAM',
    conn: 'connections',
    load: 'load',
    updated: 'updated',
    nextIn: 'next in',
    now: 'now',
    loading: 'fetching…',
    notConfigured: 'configure your project to start',
    breaker: 'paused after repeated errors — hit refresh to retry',
    showHide: 'show/hide',
    refreshNow: 'refresh now',
    settings: 'settings',
    openDashboard: 'open supabase dashboard',
    quit: 'quit',
    infraOff: 'infra unavailable (service key?)',
  },
};

function t(locale, key) {
  return (LOCALES[locale] || LOCALES['pt-BR'])[key] ?? key;
}

if (typeof module !== 'undefined') module.exports = { t, LOCALES };
if (typeof window !== 'undefined') window.__i18n = { t, LOCALES };
