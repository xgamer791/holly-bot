// Holly Bot Computer itself (computer/holly-computer.mjs), which this app runs on
// the Node.js it comes with, with the options from its settings
// (settings.js), as `node holly-computer.mjs` runs elsewhere.
//
// The file is kept current the way Holly Bot Computer keeps itself current
// (computer/src/update.mjs): as it starts, the Holly Bot site is asked for the
// latest one, and while it runs, Holly Bot Computer says when a newer one is out
// and no bot is working; that one is fetched, and Holly Bot Computer restarts to
// run it once no bot is working. The latest is kept in this app's own folder,
// next to what the app came with, and whichever is newer runs.
//
// What Holly Bot Computer prints goes to the Activity tab and a log file. How
// things stand there (its page, whether it's linked, the tunnel, what bots
// can use) comes over Node's IPC (computer/src/main.mjs tellDesktop), and so
// does the word to stop, which lets it tell the account it's stopping.

import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { net } from 'electron';
import { LATEST, buildVersion, newerVersion } from '../../computer/src/update.mjs';
import { computerArgs } from './settings.js';

/** Lines of what Holly Bot Computer printed that the Activity tab keeps. */
const MAX_LINES = 2000;
/** The log file starts again past this size (the last one is kept as .old). */
const LOG_LIMIT = 2 * 1024 * 1024;
/** How long Holly Bot Computer gets to stop by itself (telling the account it's stopping) before it's made to. */
const STOP_MS = 15_000;
/** Holly Bot Computer that stops by itself after running this long is started again; sooner, it failed to start. */
const STEADY_MS = 60_000;
/** At most this many of those starts again in half an hour. */
const MAX_RESTARTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The version a holly-computer.mjs was built from, or null (none there). */
function versionOf(file) {
  try {
    return buildVersion(readFileSync(file, 'utf8').slice(0, 2000));
  } catch {
    return null;
  }
}

/** Runs `cmd` to the end: its exit code. */
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

/** Stops process `pid` and everything it started. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch { /* gone already */ }
}

export class HollyComputer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.resources  what the app comes with: node\ (Node.js) and computer\ (holly-computer.mjs)
   * @param {string} o.home  the app's own folder: a newer holly-computer.mjs, and the log
   * @param {string} o.appVersion  this app's version, which Holly Bot Computer tells the phone
   */
  constructor({ resources, home, appVersion }) {
    super();
    this.appVersion = appVersion;
    const node = join(resources, 'node', 'node.exe');
    this.bundledNode = process.platform === 'win32' && existsSync(node);
    this.node = this.bundledNode ? node : 'node';
    this.bundled = join(resources, 'computer', 'holly-computer.mjs');
    this.own = join(home, 'computer', 'holly-computer.mjs');
    this.logFile = join(home, 'logs', 'holly-computer.log');
    /** 'starting', 'running', 'restarting', 'stopping', 'stopped' or 'failed'. */
    this.status = 'stopped';
    /** How things stand there, as Holly Bot Computer last said (computer/src/main.mjs tellState). */
    this.state = null;
    /** Why it stopped when it shouldn't have: { kind: 'port' | 'crash' | 'missing', port, detail }. */
    this.error = null;
    /** The settings it runs with. */
    this.config = null;
    /** The version of holly-computer.mjs it runs. */
    this.version = null;
    this.lines = [];
    this.child = null;
    this.launching = null; // a start under way (start)
    this.run = 0; // each start and stop, so a start that's overtaken lets go
    this.stopping = false;
    this.updateRestart = false;
    this.idleStop = null; // stopping for this app's update (stopWhenIdle)
    this.fetching = false;
    this.restarts = [];
    this.pending = [];
    this.logged = 0;
    this.rotateLog();
  }

  /** Whether it's running, or on its way. */
  get active() {
    return ['starting', 'running', 'restarting'].includes(this.status);
  }

  set(status) {
    this.status = status;
    this.emit('change');
  }

  /** Starts Holly Bot Computer with `settings` (settings.js); `newToken`: with
   * new keys (--new-token); `quick`: someone's waiting for it, so a newer
   * holly-computer.mjs gets only a few seconds to arrive first (it's
   * fetched while it runs otherwise, and it restarts for it then). */
  async start(settings, opts = {}) {
    // One start at a time: another waits for it, then finds it running.
    while (this.launching) await this.launching;
    if (this.child) return;
    let done;
    this.launching = new Promise((resolve) => {
      done = resolve;
    });
    try {
      await this.startNow(settings, opts);
    } finally {
      this.launching = null;
      done();
    }
  }

  async startNow(settings, { newToken = false, restarting = false, quick = false }) {
    const run = ++this.run;
    this.config = { ...settings };
    this.error = null;
    this.state = null;
    this.set(restarting ? 'restarting' : 'starting');
    const script = await this.prepare(settings.update, { quick });
    if (run !== this.run) return; // stopped meanwhile
    if (!script) {
      this.error = { kind: 'missing' };
      this.set('failed');
      return;
    }
    this.launch(script, computerArgs(settings, { newToken }));
  }

  launch(script, args) {
    this.version = versionOf(script);
    let child;
    try {
      child = spawn(this.node, [script, ...args], {
        cwd: os.homedir(),
        env: this.env(),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
    } catch (err) {
      this.fail(err);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.pipe(child.stdout);
    this.pipe(child.stderr);
    child.on('message', (message) => this.onMessage(message));
    child.on('error', (err) => {
      if (child.pid == null && this.child === child) {
        this.child = null;
        this.fail(err);
      }
    });
    // Once all it printed is in, to tell why it stopped.
    child.on('close', (code, signal) => this.onExit(child, code, signal));
  }

  fail(err) {
    this.line(`  Holly Bot Computer couldn't start: ${err?.message || err}`);
    this.error = { kind: 'crash', detail: err?.message || String(err) };
    this.set('failed');
  }

  /** Stops Holly Bot Computer: it tells the account it's stopping, and after
   * STOP_MS it's made to stop, with everything it started. */
  async stop() {
    this.run++;
    this.updateRestart = false;
    this.idleStop?.done(false);
    const child = this.child;
    if (!child) {
      if (this.status !== 'failed') this.set('stopped');
      return;
    }
    this.stopping = true;
    this.set('stopping');
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
    try {
      child.send({ type: 'stop' });
    } catch { /* its channel closed: it's stopping already */ }
    if (!(await Promise.race([exited, sleep(STOP_MS).then(() => false)]))) {
      killTree(child.pid);
      await Promise.race([exited, sleep(5000)]);
    }
    if (this.child === child) this.child = null;
    this.stopping = false;
    this.state = null;
    this.set('stopped');
  }

  async restart(settings, opts = {}) {
    await this.stop();
    await this.start(settings, { ...opts, restarting: true });
  }

  /**
   * Stops Holly Bot Computer once no bot is working, as it restarts for a
   * newer holly-computer.mjs (computer/src/main.mjs restartWhenIdle), so this
   * app can install a newer version of itself. True once it has stopped;
   * false when it wasn't running, or was stopped or restarted meanwhile.
   */
  stopWhenIdle() {
    if (this.idleStop) return this.idleStop.promise;
    if (!this.child || this.stopping || this.status !== 'running') return Promise.resolve(false);
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    this.idleStop = {
      promise,
      done: (stopped) => {
        this.idleStop = null;
        resolve(stopped);
      },
    };
    try {
      this.child.send({ type: 'restart' });
    } catch {
      this.idleStop.done(false); // its channel closed: it's stopping already
    }
    return promise;
  }

  onMessage(message) {
    if (message?.type === 'state') {
      this.state = message;
      if (this.status === 'starting' || this.status === 'restarting') this.status = 'running';
      this.emit('change');
    } else if (message?.type === 'update') {
      this.onUpdate(message.version);
    }
  }

  onExit(child, code, signal) {
    if (child !== this.child) return;
    this.child = null;
    this.state = null;
    if (this.stopping) return; // stop() carries on
    if (this.idleStop) {
      // Stopped for this app's update (stopWhenIdle).
      this.updateRestart = false;
      this.set('stopped');
      this.idleStop.done(true);
      return;
    }
    if (this.updateRestart) {
      // Stopped for the newer one (computer/src/main.mjs restartWhenIdle).
      this.updateRestart = false;
      this.start(this.config, { restarting: true });
      return;
    }
    // Stopped by itself.
    const said = this.lines.slice(-15).join('\n');
    const port = /EADDRINUSE/.test(said) ? this.config?.port : null;
    if (port) {
      this.error = { kind: 'port', port };
      this.set('failed');
      return;
    }
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < 30 * 60_000);
    if (now - this.startedAt >= STEADY_MS && this.restarts.length < MAX_RESTARTS) {
      // It had been running: it starts again.
      this.restarts.push(now);
      this.line(`  Holly Bot Computer stopped (${signal || `code ${code}`}). Starting it again…`);
      this.set('restarting');
      const run = this.run;
      setTimeout(() => {
        if (run === this.run && !this.child) this.start(this.config, { restarting: true });
      }, 5000);
      return;
    }
    const detail = said.split('\n').reverse().find((line) => /error|failed|couldn't|can't|cannot/i.test(line))?.trim();
    this.error = { kind: 'crash', detail: detail || `${signal || `code ${code}`}` };
    this.set('failed');
  }

  /**
   * Holly Bot Computer says a newer one is out and no bot is working: it's
   * fetched, and then Holly Bot Computer restarts to run it as soon as no bot is
   * working (computer/src/main.mjs restartWhenIdle).
   */
  async onUpdate(version) {
    if (this.fetching || !this.child || !this.config?.update || !this.version || !newerVersion(String(version), this.version)) return;
    this.fetching = true;
    try {
      const saved = versionOf(this.own);
      let ready = !!saved && newerVersion(saved, this.version);
      if (!ready) {
        const latest = await this.fetchLatest();
        ready = !!latest && newerVersion(latest.version, this.version) && await this.save(latest.text);
      }
      if (ready && this.child && !this.stopping) {
        this.updateRestart = true;
        this.child.send({ type: 'restart' });
      }
    } catch { /* next time */ } finally {
      this.fetching = false;
    }
  }

  /** The holly-computer.mjs to run: the newest there is, after asking the
   * Holly Bot site for a newer one (`update`; `quick`: for a few seconds at
   * most). Null when there's none. */
  async prepare(update, { quick = false } = {}) {
    const own = versionOf(this.own);
    const bundled = versionOf(this.bundled);
    let script = own && (!bundled || newerVersion(own, bundled)) ? this.own : bundled ? this.bundled : null;
    if (!update) return script;
    const current = own && script === this.own ? own : bundled;
    const latest = await this.fetchLatest(quick ? 6000 : 25_000);
    if (latest && (!current || newerVersion(latest.version, current)) && await this.save(latest.text)) {
      this.line(current ? `  Updated Holly Bot Computer from ${current} to ${latest.version}.` : `  Got Holly Bot Computer ${latest.version}.`);
      script = this.own;
    }
    return script;
  }

  /** The latest holly-computer.mjs on the Holly Bot site: { version, text },
   * or null (also when it takes longer than `limit` ms). */
  async fetchLatest(limit = 25_000) {
    const ask = async () => {
      const res = await net.fetch(`${LATEST}?t=${Date.now()}`, { signal: AbortSignal.timeout(limit) });
      if (!res.ok) return null;
      const text = await res.text();
      const version = buildVersion(text);
      return version && text.includes('globalThis.__HOLLY_BUNDLE__ = true;') ? { version, text } : null;
    };
    try {
      return await Promise.race([ask(), sleep(limit).then(() => null)]);
    } catch {
      return null; // offline, or the site is slow: next time
    }
  }

  /** Keeps `text` as the app's own holly-computer.mjs, once Node can read all of it. */
  async save(text) {
    const download = `${this.own}.download`;
    try {
      mkdirSync(dirname(this.own), { recursive: true });
      writeFileSync(download, text);
      if (await run(this.node, ['--check', download]) !== 0) throw new Error('the download was incomplete');
      renameSync(download, this.own);
      return true;
    } catch (err) {
      rmSync(download, { force: true });
      this.line(`  Couldn't update Holly Bot Computer (${err.message}).`);
      return false;
    }
  }

  /**
   * What Holly Bot Computer runs with: this app's environment without Electron's
   * own variables (with those, an Electron app a bot starts from the shell
   * would run as Node), HOLLY_DESKTOP, which opens its channel to this app,
   * and HOLLY_DESKTOP_VERSION, this app's version (which also says it
   * installs its own updates: computer/src/desktop-update.mjs). The Node.js
   * this app comes with goes on the end of the PATH, so bots have node, npm
   * and npx (and plugins started with npx work) whether or not Node.js is
   * installed; one that is comes first.
   */
  env() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^ELECTRON_/i.test(key) || /^CHROME_CRASHPAD_PIPE_NAME$/i.test(key)) continue;
      env[key] = value;
    }
    env.HOLLY_DESKTOP = '1';
    if (this.appVersion) env.HOLLY_DESKTOP_VERSION = this.appVersion;
    if (this.bundledNode) {
      const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'Path';
      const dirs = String(env[pathKey] || '').split(';').filter(Boolean);
      const has = (dir) => dirs.some((d) => d.replace(/[\\/]+$/, '').toLowerCase() === dir.toLowerCase());
      const installed = dirs.some((dir) => {
        try {
          return existsSync(join(dir, 'node.exe'));
        } catch {
          return false;
        }
      });
      const nodeDir = dirname(this.node);
      if (!has(nodeDir)) dirs.push(nodeDir);
      if (!installed) {
        // Where npm puts what's installed globally, as Node.js's own installer has it.
        const npmGlobal = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'npm');
        if (!has(npmGlobal)) dirs.push(npmGlobal);
        if (!Object.keys(env).some((key) => key.toLowerCase() === 'npm_config_prefix')) env.npm_config_prefix = npmGlobal;
      }
      env[pathKey] = dirs.join(';');
    }
    return env;
  }

  pipe(stream) {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop().slice(-8000);
      for (const part of parts) this.line(part);
    });
    stream.on('end', () => {
      if (rest) this.line(rest);
      rest = '';
    });
  }

  /** One line of what Holly Bot Computer printed (or of what this app says about it). */
  line(text) {
    // eslint-disable-next-line no-control-regex
    const clean = String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, '');
    this.lines.push(clean);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.pending.push(clean);
    this.flushTimer ||= setTimeout(() => {
      this.flushTimer = null;
      const lines = this.pending;
      this.pending = [];
      this.emit('lines', lines);
    }, 100);
    try {
      appendFileSync(this.logFile, `${new Date().toISOString()} ${clean}\n`);
    } catch { /* no log file: the Activity tab still has it */ }
    if (++this.logged % 500 === 0) this.rotateLog();
  }

  rotateLog() {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      if (existsSync(this.logFile) && statSync(this.logFile).size > LOG_LIMIT) renameSync(this.logFile, this.logFile.replace(/\.log$/, '.old.log'));
    } catch { /* keeps writing to it */ }
  }
}
