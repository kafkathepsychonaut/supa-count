// Supa Count — main process. Irmão do Count Claudula (mesma arquitetura):
// main = estado + polling + tray + janelas; renderer só desenha o que chega
// por IPC. Widget frameless, always-on-top, fechar = esconder (vive na tray).

'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, powerMonitor, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { fetchAll } = require('./supabase');
const { t } = require('./i18n');

const WIN_W = 280;
const H_MIN = 120;
const H_EXT_MAX = 560;

// Polling: cadência escolhida por resultado (padrão count-claudula).
const POLL_ERROR_MS = 90 * 1000;
const BACKOFF_START_MS = 5 * 60 * 1000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
const BREAKER_TRIP = 3;

let win = null;
let settingsWin = null;
let tray = null;
let quitting = false;

let cfg = null;
let lastGood = null;
let lastError = null;
let polling = false;
let pollQueued = false;
let pollTimer = null;
let backoffMs = 0;
let rejects4xx = 0;
let breakerOpen = false;
let extHeight = H_MIN;

// ── estado de update (electron-updater, consent-first) ─────────────────────
let updateAvailable = false; // release mais nova existe (só metadados)
let updateDownloading = false;
let updateReady = false;     // baixado; "atualizar e reiniciar" no tray + banner
let updateVersion = '';
let updateProgress = 0;

// ── config (userData/config.json — local, nunca no repo) ────────────────────
function cfgPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function defaultCfg() {
  return {
    projectRef: '',
    projectName: '',
    managementToken: '',
    serviceRoleKey: '',
    // Token do GitHub (fine-grained, Contents:read no repo) — SÓ pra o updater
    // ler as releases do repo PRIVADO. Fica no config local, nunca no instalador.
    githubToken: '',
    dbLimitGb: 8,
    storageLimitGb: 100,
    mauLimit: 100000,
    refreshSec: 300,
    theme: 'dark',
    locale: 'pt-BR',
  };
}
function loadCfg() {
  try {
    cfg = { ...defaultCfg(), ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) };
  } catch {
    cfg = defaultCfg();
  }
}
function saveCfg() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('[cfg] save', e.message);
  }
}
const configured = () => Boolean(cfg.projectRef && cfg.managementToken);

// ── janela ───────────────────────────────────────────────────────────────────
function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function loadPos() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}
function savePos() {
  if (!win) return;
  try {
    const [x, y] = win.getPosition();
    fs.writeFileSync(statePath(), JSON.stringify({ x, y }));
  } catch { /* best-effort */ }
}
function clampPosition(pos) {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  const inside = displays.some((d) => {
    const b = d.workArea;
    return pos.x >= b.x - 40 && pos.x < b.x + b.width - 60 && pos.y >= b.y - 10 && pos.y < b.y + b.height - 60;
  });
  if (inside) return pos;
  const p = screen.getPrimaryDisplay().workArea;
  return { x: p.x + p.width - WIN_W - 24, y: p.y + 80 };
}

function createWindow() {
  const saved = loadPos();
  const pos = clampPosition({ x: saved.x ?? 99999, y: saved.y ?? 80 });
  win = new BrowserWindow({
    width: WIN_W,
    height: extHeight,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (!configured()) openSettings();
  });
  win.on('moved', savePos);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function pushInit() {
  send('ui:init', {
    theme: cfg.theme,
    locale: cfg.locale,
    projectName: cfg.projectName || cfg.projectRef,
    limits: { dbLimitGb: cfg.dbLimitGb, storageLimitGb: cfg.storageLimitGb, mauLimit: cfg.mauLimit },
    refreshSec: cfg.refreshSec,
    configured: configured(),
  });
}

// Handshake: o RENDERER pede o estado quando os listeners já estão registrados
// — elimina o race "main mandou init antes do renderer escutar" (widget abria
// vazio na primeira execução, 2026-07-02).
ipcMain.on('ui:ready', () => {
  pushInit();
  if (lastGood) send('usage:update', lastGood);
  if (lastError) send('usage:error', lastError);
  if (breakerOpen) send('usage:breaker', true);
  send('update:state', updateUiState());
});

// Altura dirigida pelo renderer (conteúdo varia por idioma/erros).
ipcMain.on('ui:height', (_e, h) => {
  const target = Math.max(H_MIN, Math.min(H_EXT_MAX, Math.round(h)));
  if (Math.abs(target - extHeight) < 3 || !win) return;
  extHeight = target;
  const [x, y] = win.getPosition();
  win.setBounds({ x, y, width: WIN_W, height: extHeight });
});

// ── polling ──────────────────────────────────────────────────────────────────
function scheduleNext(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

async function poll() {
  if (!configured()) return;
  if (breakerOpen) return; // só pollNow re-arma
  if (polling) {
    pollQueued = true;
    return;
  }
  polling = true;
  send('usage:loading', true);
  try {
    const data = await fetchAll({
      projectRef: cfg.projectRef,
      managementToken: cfg.managementToken,
      serviceRoleKey: cfg.serviceRoleKey || null,
    });
    lastGood = { ...data, nextAt: Date.now() + cfg.refreshSec * 1000 };
    lastError = null;
    backoffMs = 0;
    rejects4xx = 0;
    send('usage:update', lastGood);
    updateTrayTooltip();
    scheduleNext(cfg.refreshSec * 1000);
  } catch (e) {
    lastError = { message: e.message, status: e.status ?? null, at: Date.now() };
    send('usage:error', lastError);
    if (e.rateLimited) {
      backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_CAP_MS) : BACKOFF_START_MS;
      const wait = e.retryAfter ? Math.max(e.retryAfter * 1000, backoffMs) : backoffMs;
      scheduleNext(wait);
    } else if (e.status && e.status >= 400 && e.status < 500) {
      rejects4xx += 1;
      if (rejects4xx >= BREAKER_TRIP) {
        breakerOpen = true; // para de bater; gesto do usuário re-arma
        send('usage:breaker', true);
      } else {
        scheduleNext(POLL_ERROR_MS);
      }
    } else {
      scheduleNext(POLL_ERROR_MS); // rede/5xx: transiente
    }
  } finally {
    polling = false;
    send('usage:loading', false);
    if (pollQueued) {
      pollQueued = false;
      poll();
    }
  }
}

function pollNow() {
  if (breakerOpen) {
    breakerOpen = false;
    rejects4xx = BREAKER_TRIP - 1; // uma chance; novo 4xx re-abre
    send('usage:breaker', false);
  }
  clearTimeout(pollTimer);
  poll();
}

// ── tray ─────────────────────────────────────────────────────────────────────
function trayIcon() {
  // 16x16 desenhado na mão (BGRA): quadrado arredondado verde supabase.
  const W = 16;
  const buf = Buffer.alloc(W * W * 4);
  const set = (x, y, r, g, b, a = 255) => {
    const i = (y * W + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
  };
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const corner = (x < 2 || x > 13) && (y < 2 || y > 13);
      if (corner) continue;
      set(x, y, 0x3e, 0xcf, 0x8e); // #3ECF8E
    }
  }
  // "barras" escuras sugerindo gauge
  for (let x = 3; x <= 12; x++) { set(x, 10, 0x0f, 0x35, 0x25); set(x, 11, 0x0f, 0x35, 0x25); }
  for (let x = 3; x <= 8; x++) { set(x, 5, 0x0f, 0x35, 0x25); set(x, 6, 0x0f, 0x35, 0x25); }
  return nativeImage.createFromBitmap(buf, { width: W, height: W });
}

function updateTrayTooltip() {
  if (!tray || !lastGood) return;
  const dbPct = ((lastGood.sql.dbBytes / (cfg.dbLimitGb * 1e9)) * 100).toFixed(1);
  tray.setToolTip(`Supa Count — DB ${dbPct}% · MAU ${lastGood.sql.mauMonth}`);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const L = cfg.locale;
  const items = [
    { label: t(L, 'showHide'), click: () => (win.isVisible() ? win.hide() : win.show()) },
    { label: t(L, 'refreshNow'), click: pollNow },
    { label: t(L, 'settings'), click: openSettings },
  ];
  // Item de update espelha o banner (mesmo do count-claudula).
  if (updateReady) {
    items.push({ type: 'separator' }, { label: t(L, 'updateRestart'), click: installUpdate });
  } else if (updateDownloading) {
    items.push({ type: 'separator' }, { label: `${t(L, 'updating')} ${updateProgress}%`, enabled: false });
  } else if (updateAvailable) {
    items.push({ type: 'separator' }, { label: `${t(L, 'updateDownload')} · v${updateVersion}`, click: startUpdateDownload });
  }
  items.push(
    { type: 'separator' },
    { label: t(L, 'openDashboard'), click: () => shell.openExternal(`https://supabase.com/dashboard/project/${cfg.projectRef}`) },
    { type: 'separator' },
    { label: t(L, 'quit'), click: () => { quitting = true; app.quit(); } },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ── settings ─────────────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    title: 'Supa Count — settings',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
}

// ── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on('ui:refresh', pollNow);
ipcMain.on('ui:openSettings', openSettings);
ipcMain.on('ui:hide', () => win?.hide());
ipcMain.on('ui:update-download', startUpdateDownload);
ipcMain.on('ui:update-restart', installUpdate);
ipcMain.handle('settings:get', () => ({ ...cfg }));
ipcMain.handle('settings:set', (_e, next) => {
  const before = { ref: cfg.projectRef, tok: cfg.managementToken, srk: cfg.serviceRoleKey };
  cfg = { ...cfg, ...next };
  saveCfg();
  pushInit();
  rebuildTrayMenu();
  const credsChanged =
    before.ref !== cfg.projectRef || before.tok !== cfg.managementToken || before.srk !== cfg.serviceRoleKey;
  if (credsChanged) {
    lastGood = null;
    lastError = null;
    send('usage:update', null);
  }
  // Token de update colado/alterado → re-aplica o header pro próximo check.
  if (app.isPackaged && cfg.githubToken) {
    try { autoUpdater.addAuthHeader(`token ${cfg.githubToken}`); } catch { /* ignore */ }
  }
  if (configured()) pollNow();
  return { ok: true };
});

// ── auto-update (electron-updater) — fluxo idêntico ao count-claudula ────────
// Consent-first: nada baixa sozinho (build unsigned). Só checa metadados; o
// usuário dispara o download pelo banner/tray; instala no restart. Repo PRIVADO
// → token do config local via addAuthHeader, nunca embutido no instalador.
function updateUiState() {
  if (updateReady) return { state: 'ready', version: updateVersion };
  if (updateDownloading) return { state: 'downloading', version: updateVersion, percent: updateProgress };
  if (updateAvailable) return { state: 'available', version: updateVersion };
  return { state: 'none' };
}
function syncUpdateUi(progressOnly) {
  if (!progressOnly) rebuildTrayMenu();
  send('update:state', updateUiState());
}
function startUpdateDownload() {
  if (!updateAvailable || updateDownloading || updateReady) return;
  updateDownloading = true;
  updateProgress = 0;
  syncUpdateUi();
  autoUpdater.downloadUpdate().catch(() => { updateDownloading = false; syncUpdateUi(); });
}
function installUpdate() {
  if (!updateReady) return;
  quitting = true;
  autoUpdater.quitAndInstall(true, true); // NSIS silencioso + relança
}
function setupUpdater() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return; // só o NSIS instalado
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Repo privado: token do config habilita a leitura das releases via API.
  if (cfg.githubToken) {
    try { autoUpdater.addAuthHeader(`token ${cfg.githubToken}`); } catch { /* ignore */ }
  }
  autoUpdater.on('update-available', (info) => {
    updateAvailable = true;
    updateVersion = (info && info.version) || '';
    syncUpdateUi();
  });
  autoUpdater.on('update-not-available', () => {
    if (updateAvailable) { updateAvailable = false; updateVersion = ''; syncUpdateUi(); }
  });
  autoUpdater.on('download-progress', (p) => {
    updateProgress = Math.round((p && p.percent) || 0);
    syncUpdateUi(true);
  });
  autoUpdater.on('update-downloaded', () => { updateDownloading = false; updateReady = true; syncUpdateUi(); });
  autoUpdater.on('error', () => { if (updateDownloading) { updateDownloading = false; syncUpdateUi(); } });
  const check = () => {
    if (updateDownloading || updateReady) return;
    if (!cfg.githubToken) return; // sem token não dá pra ler o repo privado
    try { autoUpdater.checkForUpdates().catch(() => {}); } catch { /* ignore */ }
  };
  setTimeout(check, 15000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ── app lifecycle ────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    loadCfg();
    createWindow();
    tray = new Tray(trayIcon());
    tray.setToolTip('Supa Count');
    tray.on('click', () => (win.isVisible() ? win.hide() : win.show()));
    rebuildTrayMenu();

    powerMonitor.on('suspend', () => clearTimeout(pollTimer));
    powerMonitor.on('lock-screen', () => clearTimeout(pollTimer));
    powerMonitor.on('resume', pollNow);
    powerMonitor.on('unlock-screen', pollNow);

    if (configured()) poll();
    setupUpdater();
  });

  app.on('window-all-closed', () => { /* vive na tray */ });
  app.on('before-quit', () => { quitting = true; savePos(); });
}
