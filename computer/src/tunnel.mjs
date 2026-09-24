// Remote access: starts a Cloudflare quick tunnel so your phone can reach this
// computer from anywhere, and prints a QR code. cloudflared is downloaded from
// Cloudflare's official GitHub releases the first time if it isn't installed.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe';
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  if (platform === 'linux') return { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm', ia32: 'cloudflared-linux-386' }[arch] || null;
  return null;
}

function onPath(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

export function findCloudflared(dataDir) {
  const local = join(dataDir, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  return onPath('cloudflared') || (existsSync(local) ? local : null);
}

/** Path to cloudflared, downloading it into <dataDir>/bin the first time. */
export async function ensureCloudflared(dataDir, { log = console } = {}) {
  const found = findCloudflared(dataDir);
  if (found) return found;
  const asset = cloudflaredAsset();
  if (!asset) throw new Error(`No cloudflared download for ${process.platform}/${process.arch} — install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`);
  const bin = join(dataDir, 'bin');
  mkdirSync(bin, { recursive: true });
  const target = join(bin, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  log.log?.('  Downloading cloudflared from Cloudflare\'s GitHub releases (one time, about 20 MB)…');
  const res = await fetch(RELEASES + asset, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Downloading cloudflared failed (${res.status}).`);
  const data = Buffer.from(await res.arrayBuffer());
  if (asset.endsWith('.tgz')) {
    const tgz = join(bin, asset);
    writeFileSync(tgz, data);
    const r = spawnSync('tar', ['-xzf', tgz, '-C', bin]);
    rmSync(tgz, { force: true });
    if (r.status !== 0 || !existsSync(target)) throw new Error('Could not unpack cloudflared.');
  } else {
    writeFileSync(`${target}.download`, data);
    renameSync(`${target}.download`, target);
  }
  if (process.platform !== 'win32') chmodSync(target, 0o755);
  return target;
}

/**
 * Start `cloudflared tunnel --url http://localhost:<port>`. Resolves with the
 * public https URL once the tunnel is connected (connected: false if the URL
 * came but no connection did within 25s — a firewall may be blocking it).
 * `onClose` runs if the tunnel closes after that.
 */
export function startQuickTunnel(port, { log = console, bin = 'cloudflared', connectTimeoutMs = 25000, onClose = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
    let url = null;
    let done = false;
    let waitTimer = null;
    const stop = () => child.kill();
    const finish = (connected) => {
      if (done || !url) return;
      done = true;
      clearTimeout(waitTimer);
      resolve({ url, connected, stop });
    };
    const onData = (d) => {
      const text = String(d);
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !url) {
        url = m[0];
        waitTimer = setTimeout(() => finish(false), connectTimeoutMs);
      }
      if (/Registered tunnel connection/i.test(text)) {
        if (url) finish(true);
        else setTimeout(() => finish(true), 1000);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => !done && reject(err));
    child.on('exit', (code) => {
      clearTimeout(waitTimer);
      if (!done) {
        reject(new Error(`cloudflared exited (${code})`));
        return;
      }
      log.warn?.('  Tunnel closed — restart Holly Computer to get a new link.');
      onClose();
    });
    setTimeout(() => !done && !url && reject(new Error('Timed out waiting for the tunnel address')), 45000);
  });
}

/** Render a QR code for the terminal with Unicode half blocks (light modules drawn, for dark terminals). */
export function qrText(text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = '';
    for (let c = -2; c < n + 2; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
