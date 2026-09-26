// Holly Computer for Windows: Holly Computer (computer/) as a Windows app. It
// runs Holly Computer on the Node.js it comes with (computer.js), from the
// moment you sign in to Windows, in the background; shows how it's doing, and
// its settings, in a window of its own (status/); sits in the taskbar's
// corner; opens Holly Bot in a window of its own (browser.js); and keeps
// itself up to date: Holly Computer from the Holly Bot site, as it does
// everywhere, and this app from the project's GitHub releases.
//
// Holly Computer keeps what it kept before (~/.holly, ~/Holly), so a computer
// that ran `node holly-computer.mjs` carries on as the same computer: linked
// to the same account, with the same bots, keys and browser logins.

import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { HollyComputer } from './computer.js';
import { RESTART_KEYS, Settings, fromCommandLine } from './settings.js';
import { openHollyBot } from './browser.js';
import { language, setLanguage, tr } from './i18n.js';

const APP_ID = 'com.xgamer791.hollycomputer';
/** The name it starts with Windows under (HKCU\…\Run: build/installer.nsh removes it). */
const LOGIN_ITEM = 'Holly Computer';
/** How often this app asks GitHub for a newer version of itself. */
const CHECK_EVERY = 6 * 60 * 60_000;

/** Started by Windows as you signed in: just the icon in the taskbar's corner. */
const hidden = process.argv.includes('--hidden');
const given = fromCommandLine(process.argv.slice(1));

let settings;
let computer;
let tray = null;
let win = null;
let quitting = false;
/** Holly Bot opens by itself once, when this computer isn't linked yet. */
let openWhenReady = !hidden && !given.noOpen;
/** Said once: closing the window leaves Holly Computer running. */
let toldStillRunning = false;
/** A newer version of this app, downloaded: { version }. */
let update = null;
/** Said once when Holly Computer couldn't start. */
let toldFailed = false;
/** Opened again before this one was ready. */
let showWhenReady = false;
/** Asking whether to quit. */
let asking = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  // Opened again (the Start menu, the desktop): the window.
  app.on('second-instance', () => {
    if (settings) showWindow();
    else showWhenReady = true;
  });
  // Closing the window leaves Holly Computer running, in the taskbar's corner.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quit({ ask: false });
  });
  app.whenReady().then(ready);
}

/** The settings Holly Computer runs with: what's saved, and what Holly Computer.exe was started with. */
function options() {
  return { ...settings.all(), ...given.settings };
}

function resources() {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'stage');
}

function icon(name) {
  return nativeImage.createFromPath(join(__dirname, 'icons', name));
}

async function ready() {
  setLanguage(app.getPreferredSystemLanguages());
  Menu.setApplicationMenu(null);
  settings = new Settings(join(app.getPath('userData'), 'settings.json'));
  loginItem();
  computer = new HollyComputer({ resources: resources(), home: app.getPath('userData') });
  computer.on('change', changed);
  computer.on('lines', (lines) => send('holly:lines', lines));
  registerIpc();
  tray = new Tray(icon('tray.png'));
  tray.setToolTip('Holly Computer');
  tray.on('click', () => showWindow());
  refreshTray();
  createWindow({ show: !hidden || showWhenReady });
  computer.start(options(), { newToken: given.newToken });
  keepAppUpdated();
}

// ----- the window ----------------------------------------------------------------

function createWindow({ show }) {
  win = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 400,
    minHeight: 540,
    show: false,
    title: 'Holly Computer',
    backgroundColor: '#121212',
    icon: icon('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(join(__dirname, 'status', 'index.html'));
  // Only its own page, and links open in the browser.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    stillRunning();
  });
  // Windows signing out or shutting down: Holly Computer tells the account
  // it's stopping while it can.
  win.on('query-session-end', () => sessionEnding());
  win.on('session-end', () => sessionEnding());
  if (show) win.once('ready-to-show', () => win.show());
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow({ show: true });
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

/** Closing the window the first time: Holly Computer keeps running. */
function stillRunning() {
  if (toldStillRunning || !computer.active) return;
  toldStillRunning = true;
  notify(tr('Holly Computer keeps running in the background, so your bots can keep working. Open it, or quit it, from its icon in the taskbar’s corner.'));
}

function notify(body, onClick) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: 'Holly Computer', body, icon: icon('icon.png') });
  note.on('click', onClick || (() => showWindow()));
  note.show();
}

/** What the window shows (status/status.js). The page's address carries the
 * pairing token, so it stays here. */
function view() {
  const { page: _page, ...state } = computer.state || {};
  const saved = settings.all();
  const running = computer.config;
  return {
    appVersion: app.getVersion(),
    language: language(),
    status: computer.status,
    error: computer.error,
    version: computer.version,
    state: computer.state ? state : null,
    settings: saved,
    startWithWindows: startsWithWindows(),
    defaults: { workspace: join(os.homedir(), 'Holly'), data: join(os.homedir(), '.holly') },
    // Saved, but Holly Computer runs with something else until it restarts.
    restartToApply: !!running && computer.active && RESTART_KEYS.some((key) => saved[key] !== running[key] && given.settings[key] === undefined),
    update,
    logFile: computer.logFile,
  };
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/** Holly Computer changed: the window, the tray, and Holly Bot the first time. */
function changed() {
  send('holly:view', view());
  refreshTray();
  const state = computer.state;
  if (state?.page && openWhenReady) {
    openWhenReady = false;
    // Not linked yet: signing in on its page links this computer to the account.
    if (!state.linked) openHollyBot(state.page).catch(() => {});
  }
  if (computer.status === 'failed' && !toldFailed && (!win || !win.isVisible())) {
    toldFailed = true;
    notify(tr("Holly Computer couldn't start. Open it to see why."));
  }
  if (computer.status === 'running') toldFailed = false;
}

// ----- the icon in the taskbar's corner -------------------------------------------

function statusWords(status) {
  return {
    starting: tr('Starting…'),
    restarting: tr('Restarting…'),
    running: tr('Running'),
    stopping: tr('Stopping…'),
    stopped: tr('Stopped'),
    failed: tr("Couldn't start"),
  }[status] || status;
}

function refreshTray() {
  if (!tray) return;
  const status = computer.status;
  tray.setToolTip(`Holly Computer · ${statusWords(status)}`);
  const page = computer.state?.page;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('Open Holly Bot'), enabled: !!page, click: () => page && openHollyBot(page) },
    { label: tr('Show Holly Computer'), click: () => showWindow() },
    { type: 'separator' },
    ...(update ? [{ label: tr('Restart to update to {version}', { version: update.version }), click: () => installUpdate() }] : []),
    computer.active || status === 'stopping'
      ? { label: tr('Restart Holly Computer'), enabled: status === 'running', click: () => computer.restart(options()) }
      : { label: tr('Start Holly Computer'), click: () => computer.start(options()) },
    { type: 'separator' },
    { label: tr('Quit Holly Computer'), click: () => quit() },
  ]));
}

// ----- starting with Windows ------------------------------------------------------

function loginItemOptions() {
  return { path: process.execPath, args: ['--hidden'], name: LOGIN_ITEM };
}

/** Whether Windows starts this app as you sign in (Task Manager can turn that off too). */
function startsWithWindows() {
  if (!app.isPackaged) return settings.all().startWithWindows;
  return app.getLoginItemSettings(loginItemOptions()).executableWillLaunchAtLogin;
}

/** Set in Windows once, the first time (on by default), and after that only
 * when it's changed here, so turning it off in Task Manager holds. */
function loginItem(on) {
  if (!app.isPackaged) return;
  if (on === undefined) {
    if (settings.loginItemSet) return;
    on = settings.all().startWithWindows;
  }
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: on, enabled: on });
  settings.markLoginItemSet();
}

// ----- what the window asks for ------------------------------------------------------

function registerIpc() {
  const own = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('holly:get', (event) => (own(event) ? { ...view(), lines: computer.lines } : null));
  ipcMain.handle('holly:act', async (event, action, arg) => (own(event) ? act(action, arg) : null));
}

async function act(action, arg) {
  switch (action) {
    case 'open': {
      const page = computer.state?.page;
      if (page) await openHollyBot(page);
      return null;
    }
    case 'start':
      computer.start(options());
      return null;
    case 'restart':
      computer.restart(options());
      return null;
    case 'folder': {
      const state = computer.state;
      const s = options();
      const folder = { workspace: state?.workspace || s.workspace || join(os.homedir(), 'Holly'), data: state?.dataDir || s.data || join(os.homedir(), '.holly'), logs: join(app.getPath('userData'), 'logs') }[arg];
      if (folder && existsSync(folder)) await shell.openPath(folder);
      return null;
    }
    case 'pick': {
      const current = options()[arg] || join(os.homedir(), arg === 'data' ? '.holly' : 'Holly');
      const picked = await dialog.showOpenDialog(win, {
        title: arg === 'data' ? tr('Holly Computer’s data folder') : tr('The folder your bots work in'),
        defaultPath: current,
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      });
      if (picked.canceled || !picked.filePaths[0]) return null;
      settings.save({ [arg]: picked.filePaths[0] });
      changed();
      return picked.filePaths[0];
    }
    case 'set': {
      const patch = { ...(arg || {}) };
      if ('startWithWindows' in patch) loginItem(!!patch.startWithWindows);
      settings.save(patch);
      changed();
      return null;
    }
    case 'apply':
      computer.restart(options());
      return null;
    case 'newKeys': {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Holly Computer',
        message: tr('Make new keys for this computer?'),
        detail: tr('Links to it from before stop working, and every device finds it again through your account (a phone on Wi-Fi needs its new link). Holly Computer restarts.'),
        buttons: [tr('Make New Keys'), tr('Cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) computer.restart(options(), { newToken: true });
      return null;
    }
    case 'update':
      installUpdate();
      return null;
    case 'copy':
      clipboard.writeText(computer.lines.join('\n'));
      return null;
    case 'quit':
      quit();
      return null;
    default:
      return null;
  }
}

// ----- stopping -----------------------------------------------------------------------

/** Quits: Holly Computer stops first, telling the account (`ask`: after asking). */
async function quit({ ask = true } = {}) {
  if (quitting || asking) return;
  if (ask && computer?.active) {
    asking = true;
    const { response } = await dialog.showMessageBox(win?.isVisible() ? win : undefined, {
      type: 'question',
      title: 'Holly Computer',
      message: tr('Quit Holly Computer?'),
      detail: tr('Your bots stop working on this computer, and your phone can’t reach it, until you open Holly Computer again.'),
      buttons: [tr('Quit'), tr('Cancel')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).finally(() => {
      asking = false;
    });
    if (response !== 0) return;
  }
  quitting = true;
  await computer?.stop();
  tray?.destroy();
  app.quit();
}

let ending = false;
function sessionEnding() {
  if (ending) return;
  ending = true;
  quitting = true;
  // Not now: Windows could cut an installer short and leave the app broken.
  autoUpdater.autoInstallOnAppQuit = false;
  computer?.stop().finally(() => app.quit());
}

// ----- this app's own updates ------------------------------------------------------------

/** Newer versions of this app come from the project's GitHub releases: one is
 * downloaded in the background, and installs when you choose to restart for
 * it (or next time the app quits). */
function keepAppUpdated() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    const first = !update;
    update = { version: info.version };
    changed();
    if (first) notify(tr('Holly Computer for Windows {version} is ready. Restart it to update.', { version: info.version }), () => showWindow());
  });
  autoUpdater.on('error', () => { /* offline, or no release yet: next time */ });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_EVERY).unref?.();
}

/** Restarts into the newer version of this app: Holly Computer stops first, so
 * its files (and the Node.js it runs on) can be replaced. */
async function installUpdate() {
  if (!update || quitting) return;
  quitting = true;
  await computer.stop();
  tray?.destroy();
  autoUpdater.quitAndInstall(true, true);
}
