// Holly Bot opens in a window of its own: an app window of a Chromium browser
// (the default browser when it's Chrome, Edge, Brave, Vivaldi or Chromium, or
// else Microsoft Edge, which Windows comes with). It's a real browser, signed
// in to what you're signed in to there, so signing in with Apple or Google,
// dictation, voice mode and notifications work in it just as they do on
// Holly Computer's page in a browser tab. Without one, the default browser
// opens it in a tab.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { shell } from 'electron';

const CHROMIUM = /^(chrome|msedge|brave|vivaldi|chromium)\.exe$/i;

/** A value from the registry (reg.exe), or null. `value` null: the key's default. */
function readRegistry(key, value) {
  return new Promise((resolve) => {
    const args = ['query', key, ...(value ? ['/v', value] : ['/ve'])];
    execFile('reg.exe', args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      // "    ProgId    REG_SZ    ChromeHTML", or "(Default)" in Windows' own language.
      const line = String(stdout).split(/\r?\n/).find((l) => /\sREG_(EXPAND_)?SZ\s/.test(l));
      const found = line && /\sREG_(EXPAND_)?SZ\s+(.*)$/.exec(line);
      if (!found) return resolve(null);
      const text = found[2].trim();
      resolve(found[1] ? text.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole) : text);
    });
  });
}

/** The program in a command line from the registry ("C:\…\chrome.exe" --single-argument %1). */
function programOf(command) {
  if (!command) return null;
  const quoted = /^"([^"]+)"/.exec(command);
  const path = quoted ? quoted[1] : /^(.*?\.exe)\b/i.exec(command)?.[1];
  return path && existsSync(path) ? path : null;
}

/** The default browser's program, from what opens https links. */
async function defaultBrowser() {
  for (const scheme of ['https', 'http']) {
    for (const choice of ['UserChoiceLatest', 'UserChoice']) {
      const progId = await readRegistry(`HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\${choice}`, 'ProgId');
      if (!progId) continue;
      const program = programOf(await readRegistry(`HKCR\\${progId}\\shell\\open\\command`, null));
      if (program) return program;
    }
  }
  return null;
}

async function edge() {
  const env = process.env;
  const places = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]
    .filter(Boolean)
    .map((root) => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  const found = places.find((path) => existsSync(path));
  if (found) return found;
  return programOf(await readRegistry('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe', null));
}

/** The browser Holly Bot opens in: one that makes app windows, or null. */
async function appBrowser() {
  if (process.platform !== 'win32') return null;
  const chosen = await defaultBrowser().catch(() => null);
  if (chosen && CHROMIUM.test(basename(chosen))) return chosen;
  return edge().catch(() => null);
}

/** Opens Holly Bot at `url` (Holly Computer's own page) in a window of its own. */
export async function openHollyBot(url) {
  const program = await appBrowser();
  if (program) {
    const opened = await new Promise((resolve) => {
      try {
        const child = spawn(program, [`--app=${url}`], { detached: true, stdio: 'ignore' });
        child.once('error', () => resolve(false));
        child.once('spawn', () => resolve(true));
        child.unref();
      } catch {
        resolve(false);
      }
    });
    if (opened) return;
  }
  await shell.openExternal(url);
}
