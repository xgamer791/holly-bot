// The first Holly Bot Computer for Windows (1.0.0, from when it was called
// Holly Computer) downloads a newer version of itself, but installs it only
// when someone restarts it for that, or quits it. Later versions install
// themselves once no bot is working (desktop/src/main.js installWhenIdle),
// and say which version they are (HOLLY_DESKTOP_VERSION). Run by the first
// one, which doesn't, Holly Bot Computer updates it, so no one needs to be at
// the computer: it downloads the latest app from the project's GitHub
// releases, checks it against what the release says it is (latest.yml, as
// the app's own updates do), and once no bot is working, stops (telling the
// account) and starts the installer, which closes the app, replaces it, and
// starts it again in the taskbar's corner.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { newerVersion } from './update.mjs';

const RELEASES = 'https://github.com/xgamer791/holly-bot/releases';
/** The version that can't install its own updates. */
const FIRST = '1.0.0';
/** How often a newer app is looked for. */
const CHECK_EVERY = 10 * 60_000;
/** An update that didn't take isn't tried again for this long. */
const RETRY_AFTER = 6 * 60 * 60_000;

/** Where the installer is downloaded to. */
const folder = () => join(process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local'), 'holly-bot-computer-update');
/** The app's own folder: how it starts after the update goes there (desktop/src/main.js takeRestart). */
const appFolder = () => join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'Holly Computer');

/**
 * Keeps the first Holly Bot Computer for Windows up to date (above), when
 * it's what runs this. `busy()` says when not to (a bot is working, or Holly
 * Bot Computer is stopping); `install(run, version)` stops Holly Bot Computer
 * and calls `run`, which starts the installer, just before it exits. Run by a
 * later version, the download is cleared away.
 */
export function updateFirstDesktopApp({ busy, install }) {
  if (process.platform !== 'win32') return;
  if (process.env.HOLLY_DESKTOP_VERSION) {
    try {
      rmSync(folder(), { recursive: true, force: true });
    } catch { /* the installer may still be closing: next time */ }
    return;
  }
  let checking = false;
  const check = async () => {
    if (checking || busy()) return;
    checking = true;
    try {
      const latest = await latestApp();
      if (!latest || !newerVersion(latest.version, FIRST) || triedLately(latest.version)) return;
      const installer = await download(latest);
      if (!installer || busy()) return;
      writeFileSync(join(folder(), 'tried.json'), JSON.stringify({ version: latest.version, at: Date.now() }));
      try {
        mkdirSync(appFolder(), { recursive: true });
        writeFileSync(join(appFolder(), 'restart.json'), JSON.stringify({ show: false, at: Date.now() }));
      } catch { /* it starts with its window open */ }
      install(() => startInstaller(installer), latest.version);
    } catch { /* offline, or GitHub is slow: next time */ } finally {
      checking = false;
    }
  };
  setTimeout(check, 60_000).unref();
  setInterval(check, CHECK_EVERY).unref();
}

/** The latest app, from what its release says for updates: { version, file, sha512 }, or null. */
async function latestApp() {
  const res = await fetch(`${RELEASES}/latest/download/latest.yml`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const text = await res.text();
  const field = (name) => new RegExp(`^${name}:[ \\t]*['"]?([^'"\\r\\n]+?)['"]?[ \\t]*\\r?$`, 'm').exec(text)?.[1];
  const version = field('version');
  const file = field('path');
  const sha512 = field('sha512');
  return /^\d+\.\d+\.\d+$/.test(version || '') && /^[\w.-]+\.exe$/.test(file || '') && sha512 ? { version, file, sha512 } : null;
}

function triedLately(version) {
  try {
    const tried = JSON.parse(readFileSync(join(folder(), 'tried.json'), 'utf8'));
    return tried.version === version && Date.now() - tried.at < RETRY_AFTER;
  } catch {
    return false;
  }
}

async function sha512Of(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

/** The installer, downloaded (or from before), once it's all there as the release says: its path, or null. */
async function download({ version, file, sha512 }) {
  const dir = join(folder(), version);
  const installer = join(dir, file);
  if (existsSync(installer) && await sha512Of(installer) === sha512) return installer;
  mkdirSync(dir, { recursive: true });
  const part = `${installer}.download`;
  const res = await fetch(`${RELEASES}/download/windows-v${version}/${file}`, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) return null;
  const hash = createHash('sha512');
  const out = createWriteStream(part);
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'close');
  } catch (err) {
    out.destroy();
    rmSync(part, { force: true });
    throw err;
  }
  if (hash.digest('base64') !== sha512) {
    rmSync(part, { force: true });
    return null;
  }
  renameSync(part, installer);
  return installer;
}

/** Starts the installer on its own, as the app's updates do: it closes the
 * app, replaces it, and starts it again (--force-run). */
function startInstaller(installer) {
  try {
    const child = spawn(installer, ['--updated', '/S', '--force-run'], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* the app starts Holly Bot Computer again, and this is tried again later */ }
}
