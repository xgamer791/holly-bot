// Remote access: starts a Cloudflare quick tunnel (if `cloudflared` is installed)
// so your phone can reach this computer from anywhere, and prints a QR code.

import { spawn, spawnSync } from 'node:child_process';
import qrcode from 'qrcode-generator';

export function hasCloudflared() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  return r.status === 0;
}

/** Start `cloudflared tunnel --url http://localhost:<port>`; resolves the public https URL. */
export function startQuickTunnel(port, { log = console } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
    let done = false;
    const onData = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) {
        done = true;
        resolve({ url: m[0], stop: () => child.kill() });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => !done && reject(err));
    child.on('exit', (code) => {
      if (!done) reject(new Error(`cloudflared exited (${code})`));
      else log.warn?.('Tunnel closed — restart Holly Computer to get a new link.');
    });
    setTimeout(() => !done && reject(new Error('Timed out waiting for the tunnel URL')), 45000);
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
