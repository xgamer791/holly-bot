// Holly Bot for Windows: Holly Bot on your PC, with Holly Bot Computer
// (computer/) inside it. Opening it opens Holly Bot in a window of its own
// (browser.js), from Holly Bot Computer's own page, so it controls the bots on
// this computer directly. Holly Bot Computer runs silently in the
// background, on the Node.js it comes with (computer.js), from the moment you
// sign in to Windows, with an icon in the taskbar's corner; how it's doing,
// its settings and what it says are in a window of their own (status/), which
// opens only from that icon, or when it can't start. It keeps itself up to
// date: Holly Bot Computer from the Holly Bot site, as it does everywhere, and
// this app from the project's GitHub releases, installed by itself once no
// bot is working.
//
// Holly Bot Computer keeps what it kept before (~/.holly, ~/Holly), so a computer
// that ran `node holly-computer.mjs` carries on as the same computer: linked
// to the same account, with the same bots, keys and browser logins.
//
// This app was called Holly Computer at first, then Holly Bot Computer. What
// Windows knows it by stays as it was then: its folder (%APPDATA%\Holly
// Computer), the program (Holly Computer.exe, package.json "executableName")
// and its entry among what starts with Windows, so an update carries on with
// all of them; what people see says Holly Bot.

import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

app.setPath('userData', join(app.getPath('appData'), 'Holly Computer'));
/** Written as this app installs an update by itself, so the new version starts as this one was (takeRestart). */
const RESTART_FILE = join(app.getPath('userData'), 'restart.json');
/** Started again by an update it installed by itself: how it was, { show } (its window). */
const restarted = process.argv.includes('--updated') ? takeRestart() : null;
/** Started by Windows as you signed in: just the icon in the taskbar's corner. */
const atSignIn = process.argv.includes('--hidden');
const given = fromCommandLine(process.argv.slice(1));

let settings;
let computer;
let tray = null;
let win = null;
let quitting = false;
/** Holly Bot opens once Holly Bot Computer serves it (openHollyBotSoon): as
 * this app is opened, not as Windows starts it or after its own update. */
let openWhenReady = !atSignIn && !restarted && !given.noOpen;
let startingTimer = null;
/** A newer version of this app, downloaded: { version }. */
let update = null;
/** Waiting for no bot to be working, to install it (installWhenIdle). */
let installing = null;
let installTimer = null;
/** Said once when Holly Bot Computer couldn't start. */
let toldFailed = false;
/** Asking whether to quit. */
let asking = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);
  // Opened again (the Start menu, the desktop, the taskbar): Holly Bot.
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--hidden')) openHollyBotSoon();
  });
  // Closing its window leaves Holly Bot Computer running, in the taskbar's corner.
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quit({ ask: false });
  });
  app.on('will-quit', () => {
    if (tray && !tray.isDestroyed()) tray.destroy();
  });
  app.whenReady().then(ready);
}

/** How this app was as it installed an update by itself (installWhenIdle), or
 * Holly Bot Computer installed it for the first version, which can't
 * (computer/src/desktop-update.mjs): { show }, or null. Read once. */
function takeRestart() {
  try {
    const was = JSON.parse(readFileSync(RESTART_FILE, 'utf8'));
    rmSync(RESTART_FILE, { force: true });
    return Date.now() - was.at < 30 * 60_000 ? was : null;
  } catch {
    return null;
  }
}

/** The settings Holly Bot Computer runs with: what's saved, and what Holly Computer.exe was started with. */
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
  computer = new HollyComputer({ resources: resources(), home: app.getPath('userData'), appVersion: app.getVersion() });
  computer.on('change', changed);
  computer.on('lines', (lines) => send('holly:lines', lines));
  registerIpc();
  tray = new Tray(icon('tray.png'));
  tray.setToolTip('Holly Bot');
  tray.on('click', () => openHollyBotSoon());
  refreshTray();
  // Its window is there from the start, hidden (Windows says it's signing
  // out or shutting down through a window: sessionEnding), and shows only
  // when asked for, or as it was before an update it installed by itself.
  createWindow({ show: !!restarted?.show });
  // Someone's waiting for Holly Bot: no long wait for a newer holly-computer.mjs first.
  computer.start(options(), { newToken: given.newToken, quick: openWhenReady });
  if (openWhenReady) openHollyBotSoon();
  if (restarted) notify(tr('Holly Bot for Windows updated itself to {version}.', { version: app.getVersion() }));
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
    title: 'Holly Bot Computer',
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
  });
  // Windows signing out or shutting down: Holly Bot Computer tells the account
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

/** Opens Holly Bot once Holly Bot Computer serves it: straight away when it's
 * running, or as soon as it's started. When it can't start, its window
 * opens instead, which says why. */
function openHollyBotSoon() {
  const page = computer?.state?.page;
  if (page) {
    openWhenReady = false;
    clearTimeout(startingTimer);
    openHollyBot(page).catch(() => {});
    return;
  }
  openWhenReady = true;
  if (!computer) return; // this app is still starting: ready() carries on
  if (computer.status === 'failed') {
    openWhenReady = false;
    showWindow();
    return;
  }
  if (computer.status === 'stopped') computer.start(options(), { quick: true });
  // Starting takes a few seconds, more the first time: past that, it's said.
  clearTimeout(startingTimer);
  startingTimer = setTimeout(() => {
    if (openWhenReady && !computer.state?.page) notify(tr('Holly Bot is starting. It opens in a moment.'), () => {});
  }, 5000);
}

function notify(body, onClick) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: 'Holly Bot', body, icon: icon('icon.png') });
  note.on('click', onClick || (() => openHollyBotSoon()));
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
    // Saved, but Holly Bot Computer runs with something else until it restarts.
    restartToApply: !!running && computer.active && RESTART_KEYS.some((key) => saved[key] !== running[key] && given.settings[key] === undefined),
    // auto: it installs itself once no bot is working (installWhenIdle).
    update: update && { ...update, auto: !!options().update },
    logFile: computer.logFile,
  };
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/** Holly Bot Computer changed: the window, the tray, and Holly Bot once it's
 * served, when someone's waiting for it. (Not linked to an account yet,
 * signing in there links this computer.) */
function changed() {
  send('holly:view', view());
  refreshTray();
  if (openWhenReady && (computer.state?.page || computer.status === 'failed')) openHollyBotSoon();
  if (computer.status === 'failed' && !toldFailed && (!win || !win.isVisible())) {
    toldFailed = true;
    notify(tr("Holly Bot Computer couldn't start. Open it to see why."), () => showWindow());
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
  tray.setToolTip(`Holly Bot · ${statusWords(status)}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('Open Holly Bot'), click: () => openHollyBotSoon() },
    { label: tr('Holly Bot Computer settings'), click: () => showWindow() },
    { type: 'separator' },
    ...(update ? [{ label: tr('Restart to update to {version}', { version: update.version }), click: () => install() }] : []),
    computer.active || status === 'stopping'
      ? { label: tr('Restart Holly Bot Computer'), enabled: status === 'running', click: () => computer.restart(options()) }
      : { label: tr('Start Holly Bot Computer'), click: () => computer.start(options()) },
    { type: 'separator' },
    { label: tr('Quit Holly Bot'), click: () => quit() },
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
    case 'open':
      openHollyBotSoon();
      return null;
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
        title: arg === 'data' ? tr('Holly Bot Computer’s data folder') : tr('The folder your bots work in'),
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
      if (patch.update) installWhenIdle();
      return null;
    }
    case 'apply':
      computer.restart(options());
      return null;
    case 'newKeys': {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Holly Bot Computer',
        message: tr('Make new keys for this computer?'),
        detail: tr('Links to it from before stop working, and every device finds it again through your account (a phone on Wi-Fi needs its new link). Holly Bot Computer restarts.'),
        buttons: [tr('Make New Keys'), tr('Cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) computer.restart(options(), { newToken: true });
      return null;
    }
    case 'update':
      install();
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

/** Quits: Holly Bot Computer stops first, telling the account (`ask`: after asking). */
async function quit({ ask = true } = {}) {
  if (quitting || asking) return;
  if (ask && computer?.active) {
    asking = true;
    const { response } = await dialog.showMessageBox(win?.isVisible() ? win : undefined, {
      type: 'question',
      title: 'Holly Bot',
      message: tr('Quit Holly Bot?'),
      detail: tr('Your bots stop working on this computer, and your phone can’t reach it, until you open Holly Bot again.'),
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
 * downloaded in the background and installs itself once no bot is working,
 * with no one needing to be at this computer (with updates turned off in
 * its settings, it waits for that), or straight away when you restart it
 * for that, or next time the app quits. */
function keepAppUpdated() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    update = { version: info.version };
    changed();
    installWhenIdle();
  });
  autoUpdater.on('error', () => { /* offline, or no release yet: next time */ });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_EVERY).unref?.();
}

/** Installs the newer version of this app once no bot is working: Holly Bot
 * Computer stops for it as it does for a newer holly-computer.mjs, and the
 * new version starts as this one was (takeRestart). */
function installWhenIdle() {
  clearTimeout(installTimer);
  if (!update || quitting || installing || !options().update) return;
  if (computer.status === 'running') {
    installing = computer.stopWhenIdle().then((stopped) => {
      installing = null;
      if (stopped) install({ quiet: true });
      else installTimer = setTimeout(installWhenIdle, 60_000);
    });
  } else if (computer.status === 'stopped' || computer.status === 'failed') {
    install({ quiet: true });
  } else {
    installTimer = setTimeout(installWhenIdle, 30_000); // starting, restarting or stopping
  }
}

/** Restarts into the newer version of this app: Holly Bot Computer stops first, so
 * its files (and the Node.js it runs on) can be replaced. `quiet`: it
 * installed it by itself, and the new version starts as this one was. */
async function install({ quiet = false } = {}) {
  if (!update || quitting) return;
  quitting = true;
  clearTimeout(installTimer);
  if (quiet) {
    try {
      writeFileSync(RESTART_FILE, JSON.stringify({ show: !!win && !win.isDestroyed() && win.isVisible(), at: Date.now() }));
    } catch { /* it starts with its window open */ }
  }
  await computer.stop();
  autoUpdater.quitAndInstall(true, true);
  // Still here: the installer couldn't start (autoUpdater says why), so this
  // version carries on, and the update is tried again next time.
  setTimeout(() => {
    quitting = false;
    update = null;
    try {
      rmSync(RESTART_FILE, { force: true });
    } catch { /* read only straight after an update */ }
    computer.start(options());
    changed();
  }, 30_000);
}
