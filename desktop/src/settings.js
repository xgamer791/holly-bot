// Holli Bot for Windows' own settings, kept in its folder under
// %APPDATA%: the options it starts Holli Bot Computer with (the ones Holli
// Bot Computer takes on the command line, computer/src/main.mjs), and whether it
// starts with Windows. Options given to Holly Computer.exe itself on the
// command line count for that run only (fromCommandLine).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULTS = {
  /** Starts, in the taskbar's corner, when you sign in to Windows. */
  startWithWindows: true,
  /** Keeps the computer from sleeping while Holli Bot Computer runs (off: --allow-sleep). */
  keepAwake: true,
  /** Cloudflare's quick tunnel, so your phone reaches this computer from anywhere (off: --no-tunnel). */
  tunnel: true,
  /** Your own permanent https address for this computer (--public-url), in place of the tunnel. */
  publicUrl: '',
  /** Phones on the same Wi-Fi connect without signing in (--lan). */
  lan: false,
  /** The bots' Chrome runs without a window (--headless-browser). */
  headlessBrowser: false,
  /** Holli Bot Computer keeps itself up to date (off: --no-update). */
  update: true,
  /** The port Holli Bot Computer listens on (--port). */
  port: 8787,
  /** The folder the bots work in (--workspace); '' for Holli Bot Computer's own default, ~/Holly. */
  workspace: '',
  /** Holli Bot Computer's own files (--data); '' for ~/.holly. */
  data: '',
};

/** The settings that Holli Bot Computer takes as it starts, so changing them restarts it. */
export const RESTART_KEYS = ['keepAwake', 'tunnel', 'publicUrl', 'lan', 'headlessBrowser', 'update', 'port', 'workspace', 'data'];

/** `patch` with only settings that exist, each of the right kind. */
export function clean(patch = {}) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) continue;
    const kind = typeof DEFAULTS[key];
    if (kind === 'boolean') out[key] = !!value;
    else if (key === 'port') {
      const port = Math.round(Number(value));
      if (port >= 1 && port <= 65535) out.port = port;
    } else if (key === 'publicUrl') {
      const url = String(value || '').trim().replace(/\/+$/, '');
      if (!url || /^https:\/\/[^\s/]+/i.test(url)) out.publicUrl = url;
    } else if (kind === 'string') out[key] = String(value || '').trim();
  }
  return out;
}

export class Settings {
  constructor(file) {
    this.file = file;
    this.values = { ...DEFAULTS };
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.values = { ...DEFAULTS, ...clean(saved) };
      this.loginItemSet = !!saved.loginItemSet;
    } catch { /* the first run, or unreadable: the defaults */ }
  }

  all() {
    return { ...this.values };
  }

  /** Saves `patch` (see clean) and returns what changed. */
  save(patch) {
    const next = { ...this.values, ...clean(patch) };
    const changed = Object.keys(next).filter((key) => next[key] !== this.values[key]);
    this.values = next;
    this.write();
    return changed;
  }

  /** Whether starting with Windows has been set in Windows at least once (main.js loginItem). */
  markLoginItemSet() {
    if (this.loginItemSet) return;
    this.loginItemSet = true;
    this.write();
  }

  write() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify({ ...this.values, loginItemSet: !!this.loginItemSet }, null, 2)}\n`);
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/**
 * Holli Bot Computer's options given to Holly Computer.exe itself, as settings
 * for this run (`newToken` and `noOpen` besides), so a shortcut or a script
 * can start it the way `node holly-computer.mjs` takes them.
 */
export function fromCommandLine(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--no-tunnel') out.tunnel = false;
    else if (a === '--tunnel') out.tunnel = true;
    else if (a === '--public-url') out.publicUrl = next();
    else if (a === '--lan') out.lan = true;
    else if (a === '--port') out.port = next();
    else if (a === '--workspace') out.workspace = next();
    else if (a === '--data') out.data = next();
    else if (a === '--headless-browser') out.headlessBrowser = true;
    else if (a === '--allow-sleep') out.keepAwake = false;
    else if (a === '--no-update') out.update = false;
    else if (a === '--new-token') out.newToken = true;
    else if (a === '--no-open') out.noOpen = true;
  }
  const { newToken, noOpen, ...rest } = out;
  return { settings: clean(rest), newToken: !!newToken, noOpen: !!noOpen };
}

/** The options Holli Bot Computer starts with, for `s` (settings). */
export function computerArgs(s, { newToken = false } = {}) {
  const args = ['--no-open', '--port', String(s.port)];
  if (s.publicUrl) args.push('--public-url', s.publicUrl);
  else if (!s.tunnel) args.push('--no-tunnel');
  if (s.lan) args.push('--lan');
  if (s.workspace) args.push('--workspace', s.workspace);
  if (s.data) args.push('--data', s.data);
  if (s.headlessBrowser) args.push('--headless-browser');
  if (!s.keepAwake) args.push('--allow-sleep');
  if (!s.update) args.push('--no-update');
  if (newToken) args.push('--new-token');
  return args;
}
