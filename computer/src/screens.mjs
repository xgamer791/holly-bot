// A screen of its own for each bot on a Holly Bot server, the way each Grok
// Bot has a computer of its own: a virtual display with its own XFCE desktop,
// where the bot's mouse and keyboard act and its own Chrome opens
// (computer/src/local-computer.mjs), so bots never share a screen. The
// server's own screen (:0, the holly-desktop service from
// convex/lib/cloudinit.ts) stays the one shown with no bot picked. A screen
// starts when its bot first needs it and stops after half an hour unused (its
// Chrome profile, and the logins in it, stay). Only on a server: a computer
// with a real screen has just the one, which its bots share.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { delimiter, join } from 'node:path';

/** Bot screens are :10 and up; :0 is the server's own. */
const FIRST_DISPLAY = 10;
const LAST_DISPLAY = 99;
export const SCREEN_SIZE = { width: 1280, height: 800 };
const IDLE_MS = 30 * 60_000;
/** About what a screen takes with its desktop and Chrome. */
const PER_SCREEN = 700 * 2 ** 20;
/** What's kept back for the server itself. */
const RESERVED = 1.5 * 2 ** 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function which(cmd, env = process.env) {
  for (const dir of String(env.PATH || '').split(delimiter)) if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
  return null;
}

/** A bot id as a folder name. */
export function folderName(owner) {
  return String(owner).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'bot';
}

export class BotScreens {
  /** Whether bots get screens of their own here: Linux run by systemd (a Holly
   * Bot server), or with HOLLY_BOT_SCREENS=1, with Xvfb and XFCE installed. */
  static available(env = process.env) {
    return process.platform === 'linux' && !!(env.INVOCATION_ID || env.HOLLY_BOT_SCREENS === '1')
      && !!which('Xvfb', env) && !!which('startxfce4', env);
  }

  /** `onStop(owner)` lets go of what ran on a bot's screen (its Chrome);
   * `busy(owner)`: whether that bot is working, so its screen stays. */
  constructor({ dataDir, log = console, onStop = () => {}, busy = () => false }) {
    this.dir = join(dataDir, 'screens');
    this.log = log;
    this.onStop = onStop;
    this.busy = busy;
    this.screens = new Map(); // owner → { owner, display, xvfb, session, usedAt, ready, stopped }
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  /** How many can run at once: what memory allows, and at least two. */
  get max() {
    return Math.max(2, Math.floor((os.totalmem() - RESERVED) / PER_SCREEN));
  }

  /** The X display of `owner`'s screen (":12"), started when it isn't running. */
  async display(owner) {
    const have = this.screens.get(owner);
    if (have) {
      have.usedAt = Date.now();
      await have.ready;
      if (!have.stopped) return have.display;
    }
    this.makeRoom();
    const s = { owner, display: null, usedAt: Date.now(), stopped: false };
    this.screens.set(owner, s);
    s.ready = this.start(s).catch((err) => {
      this.stop(owner);
      throw err;
    });
    await s.ready;
    return s.display;
  }

  /** The screen a bot used last stays; the one unused longest makes way. */
  makeRoom() {
    const running = [...this.screens.values()].filter((s) => !s.stopped);
    if (running.length < this.max) return;
    const idle = running.filter((s) => !this.busy(s.owner)).sort((a, b) => a.usedAt - b.usedAt)[0];
    if (!idle || Date.now() - idle.usedAt < 60_000) {
      throw new Error(`All ${this.max} screens this server has room for are in use by other bots. Try again in a minute.`);
    }
    this.log.log?.(`  Stopping a screen nobody used for a while to make room for another bot's.`);
    this.stop(idle.owner);
  }

  async start(s) {
    const n = this.freeDisplay();
    s.display = `:${n}`;
    const home = join(this.dir, folderName(s.owner));
    const xfconf = join(home, 'config', 'xfce4', 'xfconf', 'xfce-perchannel-xml');
    mkdirSync(xfconf, { recursive: true });
    // XFCE's own default panel, so its first start doesn't stop to ask which one.
    const panel = '/etc/xdg/xfce4/panel/default.xml';
    if (existsSync(panel) && !existsSync(join(xfconf, 'xfce4-panel.xml'))) copyFileSync(panel, join(xfconf, 'xfce4-panel.xml'));
    s.xvfb = spawn('Xvfb', [s.display, '-screen', '0', `${SCREEN_SIZE.width}x${SCREEN_SIZE.height}x24`, '-nolisten', 'tcp', '-s', '0'],
      { stdio: 'ignore', detached: true });
    s.xvfb.on('error', () => {});
    s.xvfb.on('exit', () => {
      if (this.screens.get(s.owner) === s) this.stop(s.owner);
    });
    const socket = `/tmp/.X11-unix/X${n}`;
    for (let i = 0; i < 40 && !existsSync(socket) && !s.stopped; i++) await sleep(250);
    if (s.stopped || !existsSync(socket)) throw new Error("This bot's screen didn't start.");
    // Its own settings and D-Bus session, apart from the other bots' desktops.
    const env = { ...process.env, DISPLAY: s.display, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache') };
    delete env.DBUS_SESSION_BUS_ADDRESS;
    s.session = spawn('startxfce4', [], { env, cwd: process.env.HOME || home, stdio: 'ignore', detached: true });
    s.session.on('error', () => {});
  }

  freeDisplay() {
    const taken = new Set([...this.screens.values()].map((s) => s.display));
    for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) {
      if (!taken.has(`:${n}`) && !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
    }
    throw new Error('No display is free for another screen.');
  }

  /** A bot used its screen just now. */
  touch(owner) {
    const s = this.screens.get(owner);
    if (s) s.usedAt = Date.now();
  }

  stop(owner) {
    const s = this.screens.get(owner);
    if (!s || s.stopped) return;
    s.stopped = true;
    this.screens.delete(owner);
    this.onStop(owner);
    for (const proc of [s.session, s.xvfb]) {
      try {
        if (proc?.pid) process.kill(-proc.pid, 'SIGTERM');
      } catch { /* gone already */ }
    }
  }

  /** Screens unused for half an hour stop, unless their bot is working. */
  sweep() {
    for (const s of [...this.screens.values()]) {
      if (Date.now() - s.usedAt > IDLE_MS && !this.busy(s.owner)) this.stop(s.owner);
    }
  }

  closeAll() {
    clearInterval(this.sweeper);
    for (const owner of [...this.screens.keys()]) this.stop(owner);
  }
}
