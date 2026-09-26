// Holly Computer keeps itself current. As it starts, the single-file build
// asks the Holly Bot site for the latest one. When that's newer, it takes this
// file's place and runs instead, with the same options, so a fix reaches the
// computer the next time Holly Computer starts, the way the app on the phone
// gets one the next time it opens. --no-update skips this.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** The latest build, on the Holly Bot site (Holly Computer for Windows fetches it too: desktop/src/computer.js). */
export const LATEST = 'https://xgamer791.github.io/holly-bot/computer/holly-computer.mjs';

/** The app version a build was made from, from its header ("… (app 1.11.0). …"). */
export function buildVersion(text) {
  return /\(app (\d+\.\d+\.\d+)\)/.exec(String(text).slice(0, 2000))?.[1] || null;
}

/** The version of the build the Holly Bot site serves now, from its header;
 * null when the site can't be reached. */
export async function latestVersion() {
  try {
    const res = await fetch(`${LATEST}?t=${Date.now()}`, { headers: { Range: 'bytes=0-1999' }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? buildVersion(await res.text()) : null;
  } catch {
    return null;
  }
}

/** Whether version `a` is newer than `b` (both x.y.z). */
export function newerVersion(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * Replaces `file` (this build) with a newer one from the Holly Bot site, if
 * there is one, and runs that with `argv` until it stops. True when it did;
 * false to carry on with this build (it's the latest, or the site couldn't be
 * reached, or the new one couldn't be saved).
 */
export async function runLatest({ file, argv, log = console }) {
  if (process.env.HOLLY_UPDATED) return false; // this is the new one
  let current;
  let latest;
  let text;
  try {
    current = buildVersion(readFileSync(file, 'utf8').slice(0, 2000));
    if (!current) return false;
    const res = await fetch(`${LATEST}?t=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    text = await res.text();
    latest = buildVersion(text);
  } catch {
    return false; // offline, or the site is slow: next time
  }
  if (!latest || !newerVersion(latest, current) || !text.includes('globalThis.__HOLLY_BUNDLE__ = true;')) return false;
  const download = `${file}.download`;
  try {
    writeFileSync(download, text);
    // Only a complete file that Node can read takes this one's place.
    if (spawnSync(process.execPath, ['--check', download], { stdio: 'ignore' }).status !== 0) throw new Error('the download was incomplete');
    renameSync(download, file);
  } catch (err) {
    rmSync(download, { force: true });
    log.log?.(`\n  Couldn't update Holly Computer to ${latest} (${err.message}). Starting ${current}.`);
    return false;
  }
  log.log?.(`\n  Updated Holly Computer from ${current} to ${latest}.`);
  const child = spawn(process.execPath, [...process.execArgv, file, ...argv], { stdio: 'inherit', env: { ...process.env, HOLLY_UPDATED: '1' } });
  // Ctrl+C reaches both: the new one stops itself, and this one waits for it.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
    child.on('error', (err) => {
      log.error?.(`  Couldn't start the updated Holly Computer: ${err.message}`);
      process.exitCode = 1;
      resolve();
    });
  });
  return true;
}
