// A screen of its own for each bot on a Holli Bot server, the way Grok Bot
// does it: the bots share one computer (files, apps, and the browser with its
// logins), and each works on a screen of its own, with its own browser window,
// so two bots can use the browser at once without getting in each other's way.
// The screens are side by side on one wide virtual display (Xvfb), each
// 1280×800: a bot's Chrome window fills its screen (one Chrome for all, so the
// logins are shared: computer/src/browser-cdp.mjs), and its mouse and keyboard
// act only there (computer/src/desktop.mjs). A bot gets a screen when it first
// needs one and gives it up after half an hour unused, unless it's working.
// The server's own screen (:0, XFCE: convex/lib/cloudinit.ts) stays the one
// shown with no bot picked. Only on a server: a computer with a real screen
// has just the one, which its bots share.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { delimiter, join } from 'node:path';

export const SCREEN_SIZE = { width: 1280, height: 800 };
/** The bots' display is :10 or the first free one after. */
const FIRST_DISPLAY = 10;
const LAST_DISPLAY = 99;
const MOST = 12;
const IDLE_MS = 30 * 60_000;
/** About what a screen takes with its browser window. */
const PER_SCREEN = 400 * 2 ** 20;
/** What's kept back for the server itself. */
const RESERVED = 1.5 * 2 ** 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function which(cmd, env = process.env) {
  for (const dir of String(env.PATH || '').split(delimiter)) if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
  return null;
}

export class BotScreens {
  /** Whether bots get screens of their own here: Linux run by systemd (a Holli
   * Bot server), or with HOLLY_BOT_SCREENS=1, with Xvfb, xdotool and scrot. */
  static available(env = process.env) {
    return process.platform === 'linux' && !!(env.INVOCATION_ID || env.HOLLY_BOT_SCREENS === '1')
      && !!which('Xvfb', env) && !!which('xdotool', env) && !!which('scrot', env);
  }

  /** `onFree(owner)` lets go of what a bot had on its screen (its browser
   * window); `busy(owner)`: whether that bot is working, so it keeps its screen. */
  constructor({ log = console, onFree = () => {}, busy = () => false }) {
    this.log = log;
    this.onFree = onFree;
    this.busy = busy;
    /** How many screens fit: what memory allows, at least two. */
    this.count = Math.min(MOST, Math.max(2, Math.floor((os.totalmem() - RESERVED) / PER_SCREEN)));
    this.owners = new Map(); // owner → { index, usedAt }
    this.xvfb = null;
    this.starting = null;
    this.name = null; // ":10"
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  /** The bots' display (":10"), started when it isn't running. */
  async display() {
    if (this.name && this.xvfb && this.xvfb.exitCode === null) return this.name;
    this.starting ||= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async start() {
    const n = freeDisplay();
    const name = `:${n}`;
    const proc = spawn('Xvfb', [name, '-screen', '0', `${SCREEN_SIZE.width * this.count}x${SCREEN_SIZE.height}x24`, '-nolisten', 'tcp', '-s', '0'],
      { stdio: 'ignore', detached: true });
    proc.on('error', () => {});
    proc.on('exit', () => {
      if (this.xvfb !== proc) return;
      // Everything on it is gone: the bots get their screens again as they need them.
      this.xvfb = null;
      this.name = null;
      for (const owner of [...this.owners.keys()]) this.free(owner);
    });
    const socket = `/tmp/.X11-unix/X${n}`;
    for (let i = 0; i < 40 && !existsSync(socket) && proc.exitCode === null; i++) await sleep(250);
    if (!existsSync(socket)) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch { /* never started */ }
      throw new Error("The bots' screens didn't start.");
    }
    this.xvfb = proc;
    this.name = name;
    return name;
  }

  /** Where `owner`'s screen is: the display, and its place on it. */
  async place(owner) {
    const display = await this.display();
    let s = this.owners.get(owner);
    if (!s) {
      s = { index: this.freeIndex(), usedAt: Date.now() };
      this.owners.set(owner, s);
    }
    s.usedAt = Date.now();
    return { display, index: s.index, x: s.index * SCREEN_SIZE.width, y: 0, width: SCREEN_SIZE.width, height: SCREEN_SIZE.height };
  }

  /** A free screen, or the one unused longest, given up by its bot. */
  freeIndex() {
    const taken = new Set([...this.owners.values()].map((s) => s.index));
    for (let i = 0; i < this.count; i++) if (!taken.has(i)) return i;
    const [owner, idle] = [...this.owners].filter(([o]) => !this.busy(o)).sort((a, b) => a[1].usedAt - b[1].usedAt)[0] || [];
    if (!owner || Date.now() - idle.usedAt < 60_000) {
      throw new Error(`All ${this.count} screens this server has room for are in use by other bots. Try again in a minute.`);
    }
    this.free(owner);
    return idle.index;
  }

  /** A bot used its screen just now. */
  touch(owner) {
    const s = this.owners.get(owner);
    if (s) s.usedAt = Date.now();
  }

  /** `owner` gives up its screen. */
  free(owner) {
    if (!this.owners.delete(owner)) return;
    this.onFree(owner);
  }

  /** Screens unused for half an hour are given up, unless their bot is working. */
  sweep() {
    for (const [owner, s] of [...this.owners]) {
      if (Date.now() - s.usedAt > IDLE_MS && !this.busy(owner)) this.free(owner);
    }
  }

  closeAll() {
    clearInterval(this.sweeper);
    for (const owner of [...this.owners.keys()]) this.free(owner);
    const proc = this.xvfb;
    this.xvfb = null;
    try {
      if (proc?.pid) process.kill(-proc.pid, 'SIGTERM');
    } catch { /* gone already */ }
  }
}

function freeDisplay() {
  for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error('No display is free for the bots\' screens.');
}
