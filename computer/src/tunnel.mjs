// Remote access: a Cloudflare quick tunnel, so your phone can reach this
// computer from anywhere. cloudflared is downloaded from Cloudflare's official
// GitHub releases the first time if it isn't installed.
//
// A quick tunnel's address only works while cloudflared holds a connection to
// Cloudflare, and cloudflared hands out an address before it has one. On a
// network that blocks Cloudflare Tunnel (outbound port 7844) it gets an
// address and never connects, and a tunnel can stop working later without
// cloudflared quitting. So TunnelKeeper passes an address on (onChange, which
// tells the account: computer/src/home.mjs) only once cloudflared has
// connected and the address answers as this computer, checks it every half
// minute, and when it stops answering, takes it back and opens a new tunnel.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

/** A quick tunnel's address. Not api.trycloudflare.com, which cloudflared
 * names when asking for a tunnel fails. */
export const QUICK_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

/** A cloudflared this computer downloaded is fetched again once it's this old:
 * Cloudflare supports each version for a year. */
const OWN_MAX_AGE = 180 * 24 * 60 * 60 * 1000;

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

/** Where this computer keeps the cloudflared it downloads. */
export function ownCloudflared(dataDir) {
  return join(dataDir, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

export function findCloudflared(dataDir) {
  const local = ownCloudflared(dataDir);
  return onPath('cloudflared') || (existsSync(local) ? local : null);
}

/**
 * Path to cloudflared: the one installed on this computer, or else (or with
 * `own`) the one Holly Computer keeps in <dataDir>/bin, downloaded the first
 * time and again once it's old.
 */
export async function ensureCloudflared(dataDir, { log = console, own = false } = {}) {
  const found = own ? null : onPath('cloudflared');
  if (found) return found;
  const target = ownCloudflared(dataDir);
  if (existsSync(target) && Date.now() - statSync(target).mtimeMs < OWN_MAX_AGE) return target;
  try {
    return await downloadCloudflared(dataDir, { log });
  } catch (err) {
    if (existsSync(target)) return target; // an old one beats none
    throw err;
  }
}

async function downloadCloudflared(dataDir, { log }) {
  const asset = cloudflaredAsset();
  if (!asset) throw new Error(`No cloudflared download for ${process.platform}/${process.arch} — install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`);
  const bin = join(dataDir, 'bin');
  mkdirSync(bin, { recursive: true });
  const target = ownCloudflared(dataDir);
  log.log?.('  Downloading cloudflared from Cloudflare\'s GitHub releases (about 20 MB)…');
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
  // Its age counts from now, not from when Cloudflare built it.
  const now = new Date();
  utimesSync(target, now, now);
  return target;
}

/** Where cloudflared finds Holly Computer's server: 127.0.0.1 unless it
 * listens on one address only (--host). Not "localhost", which can mean the
 * IPv6 address the server doesn't listen on. */
export function tunnelOrigin(host, port) {
  const h = !host || ['0.0.0.0', '::', 'localhost'].includes(host) ? '127.0.0.1' : host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
}

/**
 * Asks `url` for Holly Computer's health: 'ok' when this computer answers
 * there (its `instance`, when given), 'down' when something else does
 * (Cloudflare's page for a tunnel that isn't connected), 'unknown' when the
 * question didn't get out (this computer offline, or its DNS doesn't know
 * the name yet), which says nothing about the address itself.
 */
export async function checkAddress(url, { instance = '', timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${url}/v1/health`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return 'unknown';
  }
  try {
    const data = res.ok ? await res.json() : null;
    return data?.app === 'holly-computer' && (!instance || data.instance === instance) ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

/** How long TunnelKeeper waits for what, and how often it checks. */
export const TUNNEL_TIMING = {
  /** For cloudflared to name the address. */
  urlMs: 45_000,
  /** Then for it to connect to Cloudflare. */
  connectMs: 60_000,
  /** Then the address is asked for this computer this many times, this far apart. */
  verifyTries: 6,
  verifyGapMs: 3_000,
  /** A working address is checked this often. */
  watchMs: 30_000,
  /** cloudflared has lost Cloudflare this long: a new tunnel. */
  lostMs: 60_000,
  /** The address answered as something else this many checks in a row: a new tunnel. */
  failLimit: 3,
  /** Before opening a new tunnel: after one that worked, then after each that didn't. */
  againMs: 2_000,
  backoffMs: [5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
};

/** cloudflared has connected to Cloudflare (again). */
const REGISTERED = /Registered tunnel connection/i;
/** cloudflared has lost its connection to Cloudflare, once it had one. */
const LOST = /Unregistered tunnel connection|Connection terminated|Lost connection|Retrying connection in|Failed to (dial|serve)|Serve tunnel error|Register tunnel error|connection with edge closed/i;
/** cloudflared's own checks found that this network blocks Cloudflare Tunnel
 * (both QUIC and HTTP/2 to port 7844). */
const BLOCKED = /hard_fail=true|critical failures/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Keeps a quick tunnel to this computer open. `onChange({ url, state, why })`
 * hears each change: `url` is where this computer can be reached (null while
 * it can't be), `state` is 'up', 'starting' (opening a tunnel), 'blocked'
 * (this network blocks Cloudflare Tunnel: it keeps trying) or 'stopped'.
 */
export class TunnelKeeper {
  /**
   * @param {object} o
   * @param {number} o.port  Holly Computer's port
   * @param {string} [o.host]  what it listens on (--host)
   * @param {string | (() => Promise<string>)} o.bin  cloudflared
   * @param {() => Promise<string>} [o.ownBin]  Holly Computer's own cloudflared, tried when `bin` (one found on this computer) doesn't connect
   * @param {string} [o.instance]  what /v1/health says this Holly Computer is (server.mjs)
   */
  constructor({ port, host, bin, ownBin = null, instance = '', check = checkAddress, onChange = () => {}, log = console, timing = {} }) {
    this.origin = tunnelOrigin(host, port);
    this.bin = bin;
    this.ownBin = ownBin;
    this.instance = instance;
    this.check = check;
    this.onChange = onChange;
    this.log = log;
    this.t = { ...TUNNEL_TIMING, ...timing };
    this.url = null;
    this.state = 'starting';
    this.run = null; // the cloudflared running now, and what it said
    this.path = null; // the cloudflared in use
    this.usingOwn = false;
    this.stopped = false;
    this.failedStarts = 0; // tunnels in a row that never worked
    this.noConnection = 0; // of those, the ones that never reached Cloudflare
    this.protocol = null; // null: cloudflared's choice (QUIC, then HTTP/2), or 'http2'
    this.retryTimer = null;
    this.watchTimer = null;
    this.checking = false;
    this.waiters = new Set();
  }

  /** Opens the tunnel. Resolves with the address once it works, or once it's
   * clear this network blocks the tunnel, or after `waitMs` (null then); it
   * goes on trying either way. */
  start({ waitMs = 0 } = {}) {
    this.launch();
    if (!waitMs) return Promise.resolve(this.url);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.url);
      };
      const timer = setTimeout(done, waitMs);
      this.waiters.add(done);
    });
  }

  /** Closes the tunnel for good. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchTimer);
    const run = this.run;
    this.run = null;
    if (run) this.retire(run);
    this.set(null, 'stopped');
  }

  async binary() {
    if (this.ownBin && !this.usingOwn && this.noConnection >= 2) {
      // The cloudflared installed here didn't connect: try the latest, Holly Computer's own.
      this.usingOwn = true;
      this.path = await this.ownBin();
    }
    this.path ||= typeof this.bin === 'function' ? await this.bin() : this.bin;
    return this.path;
  }

  async launch() {
    this.retryTimer = null;
    if (this.stopped || this.run) return;
    let bin;
    try {
      bin = await this.binary();
    } catch (err) {
      this.failedStarts++;
      this.log.warn?.(`  Couldn't get cloudflared, which the secure tunnel needs (${err.message}). Trying again soon.`);
      this.again();
      return;
    }
    if (this.stopped || this.run) return;
    const args = ['tunnel', '--no-autoupdate', ...(this.protocol ? ['--protocol', this.protocol] : []), '--url', this.origin];
    const run = { url: null, registered: false, connected: false, lostAt: 0, blocked: false, published: false, failures: 0, timer: null, retired: false };
    this.run = run;
    try {
      run.child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.giveUp(run, 'exited', err.message);
      return;
    }
    let rest = '';
    const onData = (chunk) => {
      const lines = (rest + String(chunk)).split(/\r?\n/);
      rest = lines.pop().slice(-4000);
      for (const line of lines) this.line(run, line);
    };
    run.child.stdout.on('data', onData);
    run.child.stderr.on('data', onData);
    run.child.on('error', (err) => this.giveUp(run, 'exited', err.message));
    run.child.on('exit', (code, signal) => this.giveUp(run, 'exited', signal || `code ${code}`));
    run.timer = setTimeout(() => this.giveUp(run, 'no-address'), this.t.urlMs);
  }

  /** One line of cloudflared's log. */
  line(run, line) {
    if (run !== this.run) return;
    if (!run.url) {
      const url = QUICK_URL.exec(line)?.[0];
      if (url) {
        run.url = url;
        clearTimeout(run.timer);
        if (run.connected) this.verify(run);
        else run.timer = setTimeout(() => this.giveUp(run, 'no-connection'), this.t.connectMs);
      }
    }
    if (REGISTERED.test(line)) {
      run.registered = true;
      run.lostAt = 0;
      if (!run.connected) {
        run.connected = true;
        if (run.url) {
          clearTimeout(run.timer);
          this.verify(run);
        }
      }
      return;
    }
    if (run.connected && LOST.test(line)) {
      if (run.registered) run.lostAt = Date.now();
      run.registered = false;
      return;
    }
    if (BLOCKED.test(line) && !run.blocked) {
      run.blocked = true;
      // It goes on trying for a while, but the account hears now.
      if (!this.url) this.blocked();
    }
  }

  /** cloudflared has connected: asks the address for this computer, and
   * passes it on once it answers. */
  async verify(run) {
    let result = 'unknown';
    for (let i = 0; i < this.t.verifyTries; i++) {
      if (i) await sleep(this.t.verifyGapMs);
      if (run !== this.run) return;
      result = await this.check(run.url, { instance: this.instance });
      if (run !== this.run) return;
      if (result === 'ok') break;
    }
    // Cloudflare answered for the address, but not with this computer.
    if (result === 'down') return this.giveUp(run, 'not-answering');
    // 'unknown': this computer couldn't ask (its DNS may not know the name
    // yet). cloudflared is connected, so other devices should get through.
    if (result === 'unknown') this.log.warn?.("  Couldn't check the secure tunnel from this computer. It's connected, so your phone should reach it.");
    this.publish(run);
  }

  publish(run) {
    run.published = true;
    this.failedStarts = 0;
    this.noConnection = 0;
    this.set(run.url, 'up');
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this.watch(run), this.t.watchMs);
    this.watchTimer.unref?.();
  }

  /** Every half minute: is the address still this computer's? */
  async watch(run) {
    if (run !== this.run || this.checking) return;
    if (!run.registered && run.lostAt && Date.now() - run.lostAt >= this.t.lostMs) return this.giveUp(run, 'lost');
    this.checking = true;
    try {
      const result = await this.check(run.url, { instance: this.instance });
      if (run !== this.run) return;
      if (result === 'ok') run.failures = 0;
      else if (result === 'down' && ++run.failures >= this.t.failLimit) this.giveUp(run, 'not-answering');
    } finally {
      this.checking = false;
    }
    return undefined;
  }

  /** Stops a cloudflared that's no longer wanted, without it counting as
   * the tunnel closing. */
  retire(run) {
    run.retired = true;
    clearTimeout(run.timer);
    try {
      run.child?.kill();
    } catch { /* gone already */ }
  }

  /**
   * This tunnel won't do (`why`: 'no-address', 'no-connection',
   * 'not-answering', 'lost' or 'exited'): the address is taken back, and a new
   * tunnel opens, straight away after one that worked, later after each that didn't.
   */
  giveUp(run, why, detail = '') {
    if (run.retired || run !== this.run || this.stopped) return;
    this.run = null;
    this.retire(run);
    clearInterval(this.watchTimer);
    if (!run.published) {
      this.failedStarts++;
      if (why === 'no-connection' || (why === 'exited' && run.url && !run.connected)) {
        this.noConnection++;
        // Maybe it's QUIC (UDP) that's blocked. cloudflared falls back to
        // HTTP/2 by itself, slowly: the next one tries each straight away.
        this.protocol = this.protocol ? null : 'http2';
      }
    }
    if (run.published) this.log.warn?.(why === 'exited' ? `  The secure tunnel closed (${detail}). Opening a new one…` : '  The secure tunnel stopped answering. Opening a new one…');
    if (run.blocked || this.noConnection >= 2) this.blocked(why);
    else this.set(null, 'starting', why);
    this.again();
  }

  /** This network blocks Cloudflare Tunnel, as far as anyone can tell: said
   * once, until a tunnel works again. */
  blocked(why = 'blocked') {
    if (this.state !== 'blocked') this.log.warn?.("  Can't open the secure tunnel: this network blocks Cloudflare Tunnel (outbound port 7844, UDP and TCP), so your phone can't reach this computer. Allow it, use another network, or start with --public-url. Holly Computer keeps trying.");
    this.set(null, 'blocked', why);
  }

  again() {
    if (this.stopped) return;
    const { againMs, backoffMs } = this.t;
    const delay = this.failedStarts ? backoffMs[Math.min(this.failedStarts, backoffMs.length) - 1] : againMs;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.launch(), delay);
    this.retryTimer.unref?.();
  }

  set(url, state, why = '') {
    const changed = url !== this.url || state !== this.state;
    this.url = url;
    this.state = state;
    if (changed) this.onChange({ url, state, why });
    if (url || state !== 'starting') for (const done of [...this.waiters]) done();
  }
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
