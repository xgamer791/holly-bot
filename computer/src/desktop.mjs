// Screen, mouse and keyboard control with no native add-ons:
//   Windows → one long-lived PowerShell helper (user32 SendInput + System.Drawing)
//   macOS   → screencapture + sips, and JavaScript for Automation (CoreGraphics events)
//   Linux   → xdotool, and ImageMagick / scrot / maim / gnome-screenshot / grim
// Coordinates here are real screen coordinates (points on macOS); LocalComputer
// maps screenshot pixels onto them.

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, delimiter } from 'node:path';
import { imageSize, shrinkPng } from './png.mjs';

const INFO_TTL = 60000;

export function which(cmd, env = process.env) {
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

function run(cmd, args, { input, timeoutMs = 20000, binary = false, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errs = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd.split(/[\\/]/).pop()} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errs.push(d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(errs).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`${cmd.split(/[\\/]/).pop()} failed${code != null ? ` (${code})` : ''}: ${stderr.slice(0, 400) || 'no output'}`));
        return;
      }
      resolve({ stdout: binary ? stdout : stdout.toString('utf8'), stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

// ----- keys -------------------------------------------------------------------------

const KEY_NAMES = {
  control: 'ctrl', ctl: 'ctrl', ctrl: 'ctrl', '⌃': 'ctrl',
  command: 'cmd', cmd: 'cmd', '⌘': 'cmd',
  option: 'alt', opt: 'alt', alt: 'alt', altgr: 'alt', '⌥': 'alt',
  shift: 'shift', '⇧': 'shift',
  super: 'super', win: 'super', windows: 'super', start: 'super', meta: 'meta',
  return: 'enter', enter: 'enter', '↵': 'enter',
  esc: 'escape', escape: 'escape',
  tab: 'tab', space: 'space', spacebar: 'space',
  backspace: 'backspace', back_space: 'backspace', bksp: 'backspace',
  delete: 'delete', del: 'delete', forwarddelete: 'delete',
  up: 'up', arrowup: 'up', down: 'down', arrowdown: 'down', left: 'left', arrowleft: 'left', right: 'right', arrowright: 'right',
  home: 'home', end: 'end',
  pageup: 'pageup', page_up: 'pageup', pgup: 'pageup', prior: 'pageup',
  pagedown: 'pagedown', page_down: 'pagedown', pgdn: 'pagedown', next: 'pagedown',
  insert: 'insert', ins: 'insert',
  printscreen: 'printscreen', print: 'printscreen', prtsc: 'printscreen',
  capslock: 'capslock', caps_lock: 'capslock', menu: 'menu', contextmenu: 'menu',
  plus: '+', minus: '-', equal: '=', equals: '=', comma: ',', period: '.', dot: '.', slash: '/', backslash: '\\',
  semicolon: ';', quote: "'", apostrophe: "'", grave: '`', backtick: '`', bracketleft: '[', bracketright: ']',
};
const MODIFIERS = new Set(['ctrl', 'cmd', 'alt', 'shift', 'super']);

/**
 * "ctrl+c", "cmd+shift+t", "enter", "alt+tab", "ctrl+a delete" (a sequence) →
 * [{ mods: ['ctrl'], key: 'c' }, …]. "cmd" means ctrl off macOS; "win"/"super" is the OS key.
 */
export function parseKeys(spec, platform = process.platform) {
  const combos = [];
  for (const part of String(spec || '').trim().split(/\s+/).filter(Boolean)) {
    const tokens = part.split(/\+(?=.)/);
    const names = tokens.map((t) => {
      const low = t.toLowerCase();
      let name = KEY_NAMES[low] ?? (/^f([1-9]|1\d|2[0-4])$/.test(low) ? low : t.length === 1 ? low : null);
      if (name == null) throw new Error(`Unknown key "${t}" in "${spec}"`);
      if (name === 'meta') name = platform === 'darwin' ? 'cmd' : 'super';
      if (name === 'cmd' && platform !== 'darwin') name = 'ctrl';
      if (name === 'super' && platform === 'darwin') name = 'cmd';
      return name;
    });
    const key = names.pop();
    combos.push({ mods: [...new Set(names.filter((n) => MODIFIERS.has(n)))], key });
  }
  if (!combos.length) throw new Error('No keys given');
  return combos;
}

// ----- Linux (X11) ----------------------------------------------------------------------

const X11_KEYS = {
  enter: 'Return', escape: 'Escape', tab: 'Tab', space: 'space', backspace: 'BackSpace', delete: 'Delete',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  insert: 'Insert', printscreen: 'Print', capslock: 'Caps_Lock', menu: 'Menu',
  ctrl: 'ctrl', alt: 'alt', shift: 'shift', super: 'super',
  '+': 'plus', '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period', '/': 'slash', '\\': 'backslash',
  ';': 'semicolon', "'": 'apostrophe', '`': 'grave', '[': 'bracketleft', ']': 'bracketright',
};
const x11Key = (k) => X11_KEYS[k] || (/^f\d+$/.test(k) ? k.toUpperCase() : k);

class LinuxDesktop {
  constructor({ log, env, region = null }) {
    this.log = log;
    this.env = { ...env };
    if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY && existsSync('/tmp/.X11-unix/X0')) this.env.DISPLAY = ':0';
    // A bot's own screen, a part of a wider display: coordinates here are
    // within it, and screenshots show only it.
    this.region = region;
    this.lastPoint = null;
    this.cached = null;
  }

  /** From this screen's coordinates to the display's. */
  at(x, y) {
    if (!this.region) return [x, y];
    const p = [Number.isFinite(x) ? this.region.x + x : x, Number.isFinite(y) ? this.region.y + y : y];
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) this.lastPoint = p;
    return p;
  }

  /**
   * Keys go to the window under this screen's pointer first: on a display
   * shared by several bots' screens, the keyboard's focus may have moved to
   * another bot's window since this one last clicked.
   *
   * No xdotool --sync, here or anywhere: X carries out a pointer move or a
   * focus change as it gets it, before whatever comes after it, so there's
   * nothing to wait for. And --sync polls for up to 15 seconds whenever what
   * it looks for doesn't show exactly (the focus on that very window, say,
   * with Chrome's windows on a display with no window manager): twice before
   * each typing or key, which could hold typing up for half a minute.
   */
  async focusHere() {
    if (!this.region) return;
    const [x, y] = this.lastPoint || [this.region.x + Math.round(this.region.width / 2), this.region.y + Math.round(this.region.height / 2)];
    try {
      const { stdout } = await this.x(['mousemove', x, y, 'getmouselocation', '--shell'], 5000);
      const win = stdout.match(/WINDOW=(\d+)/)?.[1];
      if (win) await this.x(['windowfocus', win], 5000);
    } catch { /* keys go wherever the focus is */ }
  }

  async init() {
    const w = (c) => which(c, this.env);
    this.tools = {
      xdotool: w('xdotool'), import: w('import'), magick: w('magick'), convert: w('convert'),
      scrot: w('scrot'), maim: w('maim'), gnomeScreenshot: w('gnome-screenshot'), grim: w('grim'), spectacle: w('spectacle'),
    };
    this.tmp = mkdtempSync(join(os.tmpdir(), 'holly-screen-'));
    return this;
  }

  get x11() {
    return !!this.env.DISPLAY;
  }

  x(args, timeoutMs = 20000) {
    return run(this.tools.xdotool, args.map(String), { env: this.env, timeoutMs });
  }

  screenshotTool() {
    const t = this.tools;
    if (this.x11 && (t.import || t.magick)) return 'import';
    if (this.x11 && t.scrot) return 'scrot';
    if (this.x11 && t.maim) return 'maim';
    if (t.gnomeScreenshot) return 'gnome-screenshot';
    if (t.grim) return 'grim';
    if (t.spectacle) return 'spectacle';
    return null;
  }

  async info() {
    if (this.cached && Date.now() - this.cachedAt < INFO_TTL) return this.cached;
    const notes = [];
    let width = 0;
    let height = 0;
    const t = this.tools;
    if (!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) {
      notes.push('No graphical desktop here (headless), so no screen control. Shell, files and the browser still work.');
    } else {
      if (this.region) {
        ({ width, height } = this.region);
      } else if (this.x11 && t.xdotool) {
        try {
          const { stdout } = await this.x(['getdisplaygeometry'], 5000);
          [width, height] = stdout.trim().split(/\s+/).map(Number);
        } catch (err) {
          notes.push(`xdotool: ${err.message}`);
        }
      }
      if (!width && this.screenshotTool()) {
        try {
          const png = await this.capturePng();
          const size = imageSize(png);
          width = size?.width || 0;
          height = size?.height || 0;
        } catch (err) {
          notes.push(`Screenshot failed: ${err.message}`);
        }
      }
      if (!this.screenshotTool()) notes.push('For screenshots install ImageMagick or scrot (e.g. sudo apt install imagemagick).');
      if (!t.xdotool) notes.push('For mouse and keyboard control install xdotool (e.g. sudo apt install xdotool).');
      if (this.env.WAYLAND_DISPLAY) notes.push('Wayland session: screen control works best in an X11 session (choose "on Xorg" at the login screen).');
    }
    this.cached = {
      width,
      height,
      screenshotAvailable: !!this.screenshotTool() && width > 0,
      inputAvailable: this.x11 && !!t.xdotool && width > 0,
      notes,
    };
    this.cachedAt = Date.now();
    return this.cached;
  }

  async capturePng() {
    const file = join(this.tmp, `shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const t = this.tools;
    const tool = this.screenshotTool();
    try {
      if (tool === 'import') {
        const [cmd, pre] = t.import ? [t.import, []] : [t.magick, ['import']];
        const { stdout } = await run(cmd, [...pre, '-silent', '-window', 'root', ...this.crop(), 'png:-'], { env: this.env, binary: true, timeoutMs: 15000 });
        return stdout;
      }
      const r = this.region;
      if (tool === 'scrot') await run(t.scrot, [...(r ? ['--autoselect', `${r.x},${r.y},${r.width},${r.height}`] : []), file], { env: this.env, timeoutMs: 15000 });
      else if (tool === 'maim') await run(t.maim, [...(r ? ['-g', `${r.width}x${r.height}+${r.x}+${r.y}`] : []), file], { env: this.env, timeoutMs: 15000 });
      else if (tool === 'gnome-screenshot') await run(t.gnomeScreenshot, ['-f', file], { env: this.env, timeoutMs: 15000 });
      else if (tool === 'grim') await run(t.grim, [file], { env: this.env, timeoutMs: 15000 });
      else if (tool === 'spectacle') await run(t.spectacle, ['-b', '-n', '-f', '-o', file], { env: this.env, timeoutMs: 15000 });
      else throw new Error('No screenshot tool installed.');
      return readFileSync(file);
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** The screen as a JPEG, saved by scrot itself (it goes by the file's name). */
  async scrotJpeg(quality) {
    const file = join(this.tmp, `shot-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
    const r = this.region;
    try {
      await run(this.tools.scrot, [...(r ? ['--autoselect', `${r.x},${r.y},${r.width},${r.height}`] : []), '--quality', String(quality), file], { env: this.env, timeoutMs: 15000 });
      return readFileSync(file);
    } finally {
      rmSync(file, { force: true });
    }
  }

  async screenshot({ maxWidth = 1280, quality = 70 } = {}) {
    const info = await this.info();
    const t = this.tools;
    const tw = info.width ? Math.min(maxWidth, info.width) : maxWidth;
    if (this.screenshotTool() === 'import') {
      const [cmd, pre] = t.import ? [t.import, []] : [t.magick, ['import']];
      const { stdout } = await run(cmd, [...pre, '-silent', '-window', 'root', ...this.crop(), '-resize', `${tw}x`, '-quality', String(quality), 'jpeg:-'], { env: this.env, binary: true, timeoutMs: 15000 });
      const size = imageSize(stdout) || { width: tw, height: Math.round((info.height * tw) / (info.width || tw)) };
      return { data: stdout.toString('base64'), mime: 'image/jpeg', width: size.width, height: size.height, screenWidth: info.width || size.width, screenHeight: info.height || size.height };
    }
    // Wanted at full size (a bot's own screen always is), scrot saves a JPEG
    // itself: a fraction of a PNG's size, which the app's live view fetches
    // every second or two. A scrot that can't, three times running, is left
    // to its PNGs.
    if (this.screenshotTool() === 'scrot' && info.width && tw >= info.width && (this.jpegFails || 0) < 3) {
      const jpeg = await this.scrotJpeg(quality).catch(() => null);
      const size = imageSize(jpeg);
      if (size?.mime === 'image/jpeg') {
        this.jpegFails = 0;
        return { data: jpeg.toString('base64'), mime: 'image/jpeg', width: size.width, height: size.height, screenWidth: info.width, screenHeight: info.height || size.height };
      }
      this.jpegFails = (this.jpegFails || 0) + 1;
    }
    const png = await this.capturePng();
    const src = imageSize(png);
    if (t.convert || t.magick) {
      const [cmd, pre] = t.convert ? [t.convert, []] : [t.magick, []];
      const { stdout } = await run(cmd, [...pre, 'png:-', '-resize', `${tw}x>`, '-quality', String(quality), 'jpeg:-'], { input: png, env: this.env, binary: true, timeoutMs: 15000 });
      const size = imageSize(stdout);
      return { data: stdout.toString('base64'), mime: 'image/jpeg', width: size.width, height: size.height, screenWidth: info.width || src.width, screenHeight: info.height || src.height };
    }
    const small = shrinkPng(png, tw);
    return { data: small.buffer.toString('base64'), mime: 'image/png', width: small.width, height: small.height, screenWidth: info.width || small.sourceWidth, screenHeight: info.height || small.sourceHeight };
  }

  async move(x, y) {
    const [X, Y] = this.at(x, y);
    await this.x(['mousemove', X, Y]);
  }

  async click(x, y, { button = 'left', double = false } = {}) {
    const b = { left: 1, middle: 2, right: 3 }[button] || 1;
    let [X, Y] = this.at(x, y);
    // Where this screen's pointer was: the pointer may be on another bot's screen now.
    if (this.region && !(Number.isFinite(X) && Number.isFinite(Y))) [X, Y] = this.lastPoint || this.at(Math.round(this.region.width / 2), Math.round(this.region.height / 2));
    const move = Number.isFinite(X) && Number.isFinite(Y) ? ['mousemove', X, Y] : [];
    await this.x([...move, 'click', ...(double ? ['--repeat', 2, '--delay', 90] : []), b]);
  }

  async drag(x1, y1, x2, y2) {
    const [X1, Y1] = this.at(x1, y1);
    const [X2, Y2] = this.at(x2, y2);
    const mx = Math.round((X1 + X2) / 2);
    const my = Math.round((Y1 + Y2) / 2);
    await this.x(['mousemove', X1, Y1, 'mousedown', 1, 'sleep', 0.15, 'mousemove', mx, my, 'sleep', 0.08, 'mousemove', X2, Y2, 'sleep', 0.12, 'mouseup', 1]);
  }

  async type(text) {
    if (!text) return;
    await this.focusHere();
    await this.x(['type', '--delay', 12, '--clearmodifiers', '--', text], 10000 + text.length * 40);
  }

  async key(spec) {
    const combos = parseKeys(spec, 'linux').map(({ mods, key }) => [...mods, key].map(x11Key).join('+'));
    await this.focusHere();
    await this.x(['key', '--clearmodifiers', '--delay', 40, '--', ...combos]);
  }

  async scroll(x, y, { direction = 'down', amount = 5 } = {}) {
    const b = { up: 4, down: 5, left: 6, right: 7 }[direction] || 5;
    const [X, Y] = this.at(x, y);
    await this.x(['mousemove', X, Y, 'click', '--repeat', Math.max(1, Math.min(50, amount)), '--delay', 40, b]);
  }

  async cursor() {
    const { stdout } = await this.x(['getmouselocation', '--shell']);
    let x = Number(stdout.match(/X=(\d+)/)?.[1]);
    let y = Number(stdout.match(/Y=(\d+)/)?.[1]);
    const r = this.region;
    if (r) {
      // Off this screen (another bot moved it): where it last was here.
      if (!(x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) [x, y] = this.lastPoint || [r.x, r.y];
      x -= r.x;
      y -= r.y;
    }
    return { x, y };
  }

  /** ImageMagick's crop to this screen, when it's part of a wider display. */
  crop() {
    const r = this.region;
    return r ? ['-crop', `${r.width}x${r.height}+${r.x}+${r.y}`, '+repage'] : [];
  }

  async close() {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

// ----- macOS ----------------------------------------------------------------------------

const MAC_KEYCODES = {
  enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126, capslock: 57, cmd: 55, shift: 56, alt: 58, ctrl: 59,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
const MAC_MODS = { cmd: 'command down', alt: 'option down', ctrl: 'control down', shift: 'shift down' };

// CoreGraphics mouse events from JXA. Numeric constants avoid bridge surprises:
// 1/2 left down/up, 3/4 right down/up, 25/26 other down/up, 5 moved, 6 left-dragged;
// field 1 = click state; tap 0 = HID event tap.
const MAC_MOUSE = `ObjC.import('CoreGraphics');
function ev(type, x, y, button, clicks) {
  var e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);
  if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks);
  $.CGEventPost(0, e);
}
function here() { var l = $.CGEventGetLocation($.CGEventCreate(null)); return [l.x, l.y]; }
`;

class MacDesktop {
  constructor({ log }) {
    this.log = log;
    this.cached = null;
  }

  async init() {
    this.tmp = mkdtempSync(join(os.tmpdir(), 'holly-screen-'));
    return this;
  }

  async jxa(script, timeoutMs = 20000) {
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', script], { timeoutMs });
    return stdout.trim();
  }

  async info() {
    if (this.cached && Date.now() - this.cachedAt < INFO_TTL) return this.cached;
    const notes = [];
    let width = 0;
    let height = 0;
    let trusted = null;
    let canRecord = null;
    try {
      const out = await this.jxa(`ObjC.import('AppKit'); ObjC.import('ApplicationServices');
var f = $.NSScreen.mainScreen.frame, t = null, r = null;
try { t = $.AXIsProcessTrusted(); } catch (e) {}
try { ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]); r = $.CGPreflightScreenCaptureAccess(); } catch (e) {}
JSON.stringify({ w: f.size.width, h: f.size.height, trusted: t, record: r })`);
      const j = JSON.parse(out);
      width = Math.round(j.w);
      height = Math.round(j.h);
      trusted = j.trusted;
      canRecord = j.record;
    } catch (err) {
      notes.push(`Could not read the screen size: ${err.message}`);
    }
    if (trusted === false) notes.push('To let bots use the mouse and keyboard: System Settings → Privacy & Security → Accessibility → turn on your terminal app, then restart Holli Bot Computer.');
    if (canRecord === false) notes.push('To let bots see the screen: System Settings → Privacy & Security → Screen & System Audio Recording → turn on your terminal app, then restart Holli Bot Computer.');
    this.cached = { width, height, screenshotAvailable: width > 0, inputAvailable: width > 0, notes };
    this.cachedAt = Date.now();
    return this.cached;
  }

  async screenshot({ maxWidth = 1280, quality = 70 } = {}) {
    const info = await this.info();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const raw = join(this.tmp, `raw-${id}.jpg`);
    const out = join(this.tmp, `shot-${id}.jpg`);
    try {
      // -x silent, -C include the cursor, -m main display only
      await run('screencapture', ['-x', '-C', '-m', '-t', 'jpg', raw], { timeoutMs: 15000 });
      const tw = Math.min(maxWidth, info.width || maxWidth);
      await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), '--resampleWidth', String(tw), raw, '--out', out], { timeoutMs: 15000 });
      const buf = readFileSync(out);
      const size = imageSize(buf) || { width: tw, height: Math.round((info.height * tw) / (info.width || tw)) };
      return { data: buf.toString('base64'), mime: 'image/jpeg', width: size.width, height: size.height, screenWidth: info.width || size.width, screenHeight: info.height || size.height };
    } finally {
      rmSync(raw, { force: true });
      rmSync(out, { force: true });
    }
  }

  async move(x, y) {
    await this.jxa(`${MAC_MOUSE}ev(5, ${x}, ${y}, 0, 0); 'ok'`);
  }

  async click(x, y, { button = 'left', double = false } = {}) {
    const [down, up, btn] = button === 'right' ? [3, 4, 1] : button === 'middle' ? [25, 26, 2] : [1, 2, 0];
    const at = Number.isFinite(x) && Number.isFinite(y) ? `[${x}, ${y}]` : 'here()';
    await this.jxa(`${MAC_MOUSE}var p = ${at};
ev(5, p[0], p[1], 0, 0); delay(0.05);
ev(${down}, p[0], p[1], ${btn}, 1); ev(${up}, p[0], p[1], ${btn}, 1);
${double ? `delay(0.08); ev(${down}, p[0], p[1], ${btn}, 2); ev(${up}, p[0], p[1], ${btn}, 2);` : ''}
'ok'`);
  }

  async drag(x1, y1, x2, y2) {
    await this.jxa(`${MAC_MOUSE}ev(5, ${x1}, ${y1}, 0, 0); delay(0.05);
ev(1, ${x1}, ${y1}, 0, 1); delay(0.12);
for (var s = 1; s <= 12; s++) { ev(6, ${x1} + (${x2 - x1}) * s / 12, ${y1} + (${y2 - y1}) * s / 12, 0, 0); delay(0.02); }
delay(0.08); ev(2, ${x2}, ${y2}, 0, 1); 'ok'`);
  }

  async type(text) {
    if (!text) return;
    if (/^[\x20-\x7e\n\t]*$/.test(text) && text.length <= 400) {
      const steps = text.split(/(\n|\t)/).filter(Boolean).map((p) => (p === '\n' ? 'se.keyCode(36);' : p === '\t' ? 'se.keyCode(48);' : `se.keystroke(${JSON.stringify(p)});`));
      await this.jxa(`var se = Application('System Events');\n${steps.join('\n')}\n'ok'`, 10000 + text.length * 60);
      return;
    }
    // Long or non-ASCII text: paste it, then put the old clipboard back.
    await this.jxa(`ObjC.import('AppKit');
var pb = $.NSPasteboard.generalPasteboard, kind = $.NSPasteboardTypeString;
var old = pb.stringForType(kind);
pb.clearContents; pb.setStringForType($(${JSON.stringify(text)}), kind);
Application('System Events').keystroke('v', { using: 'command down' });
delay(0.5);
pb.clearContents; if (old && !old.isNil()) pb.setStringForType(old, kind);
'ok'`);
  }

  async key(spec) {
    const steps = parseKeys(spec, 'darwin').map(({ mods, key }) => {
      const using = mods.map((m) => MAC_MODS[m]).filter(Boolean);
      const opt = using.length ? `, { using: ${JSON.stringify(using)} }` : '';
      if (MAC_KEYCODES[key] != null) return `se.keyCode(${MAC_KEYCODES[key]}${opt});`;
      if (key.length === 1) return `se.keystroke(${JSON.stringify(key)}${opt});`;
      throw new Error(`The key "${key}" isn't supported on macOS`);
    });
    await this.jxa(`var se = Application('System Events');\n${steps.join('\ndelay(0.05);\n')}\n'ok'`);
  }

  async scroll(x, y, { direction = 'down', amount = 5 } = {}) {
    const n = Math.max(1, Math.min(50, amount));
    const dy = direction === 'up' ? n : direction === 'down' ? -n : 0;
    const dx = direction === 'left' ? n : direction === 'right' ? -n : 0;
    try {
      await this.jxa(`${MAC_MOUSE}ev(5, ${x}, ${y}, 0, 0); delay(0.05);
ObjC.bindFunction('CGEventCreateScrollWheelEvent2', ['id', ['id', 'int', 'int', 'int', 'int', 'int']]);
var e = $.CGEventCreateScrollWheelEvent2(null, 1, 2, ${dy}, ${dx}, 0);
$.CGEventPost(0, e); 'ok'`);
    } catch {
      // Fall back to the keyboard if the scroll-wheel call isn't available.
      await this.move(x, y);
      const k = direction === 'up' ? 'pageup' : direction === 'down' ? 'pagedown' : direction;
      await this.key(Array(Math.max(1, Math.round(n / 5))).fill(k).join(' '));
    }
  }

  async cursor() {
    const out = await this.jxa(`${MAC_MOUSE}JSON.stringify(here())`);
    const [x, y] = JSON.parse(out);
    return { x: Math.round(x), y: Math.round(y) };
  }

  async close() {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

// ----- Windows ----------------------------------------------------------------------------

const WIN_VK = {
  ctrl: 0x11, alt: 0x12, shift: 0x10, super: 0x5b, enter: 0x0d, tab: 0x09, escape: 0x1b, space: 0x20, backspace: 0x08,
  delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  printscreen: 0x2c, capslock: 0x14, menu: 0x5d,
};

function winKey(k) {
  if (WIN_VK[k] != null) return `v${WIN_VK[k]}`;
  if (/^f\d+$/.test(k)) return `v${0x6f + Number(k.slice(1))}`;
  if (/^[a-z]$/.test(k)) return `v${k.toUpperCase().charCodeAt(0)}`;
  if (/^[0-9]$/.test(k)) return `v${k.charCodeAt(0)}`;
  return `c${k.charCodeAt(0)}`;
}

/** "v17 v67|v18 v9" — combos split by |, keys by space: vNN virtual key, cNN character. */
export function windowsKeySpec(spec) {
  return parseKeys(spec, 'win32').map(({ mods, key }) => [...mods, key].map(winKey).join(' ')).join('|');
}

const WINDOWS_HOST = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing, System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class HollyDesk {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

  public static void Init() { try { SetProcessDPIAware(); } catch { } }

  public static string Q(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c < 0x20) b.Append("\\u" + ((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  static int W { get { return GetSystemMetrics(0); } }
  static int H { get { return GetSystemMetrics(1); } }

  public static string Info() { return "{\"width\":" + W + ",\"height\":" + H + "}"; }

  public static string Shot(int maxWidth, int quality) {
    int w = W, h = H;
    using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(bmp)) {
        g.CopyFromScreen(0, 0, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        try { POINT p; if (GetCursorPos(out p)) Cursors.Arrow.Draw(g, new Rectangle(p.X, p.Y, 32, 32)); } catch { }
      }
      int tw = Math.Min(maxWidth > 0 ? maxWidth : w, w);
      int th = (int)Math.Round((double)h * tw / w);
      Bitmap img = bmp;
      if (tw != w) {
        img = new Bitmap(tw, th, PixelFormat.Format24bppRgb);
        using (var g2 = Graphics.FromImage(img)) { g2.InterpolationMode = InterpolationMode.HighQualityBicubic; g2.DrawImage(bmp, 0, 0, tw, th); }
      }
      try {
        ImageCodecInfo jpeg = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
        var ps = new EncoderParameters(1);
        ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
        using (var ms = new MemoryStream()) {
          img.Save(ms, jpeg, ps);
          return "{\"width\":" + tw + ",\"height\":" + th + ",\"screenWidth\":" + w + ",\"screenHeight\":" + h + ",\"mime\":\"image/jpeg\",\"data\":\"" + Convert.ToBase64String(ms.ToArray()) + "\"}";
        }
      } finally { if (img != bmp) img.Dispose(); }
    }
  }

  static INPUT MouseIn(uint flags, int data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); return i; }
  static INPUT KeyIn(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == 0)
      throw new Exception("Windows blocked the input. An administrator window, a UAC prompt or the lock screen may be in front.");
  }
  static void To(int x, int y) { SetCursorPos(x, y); Thread.Sleep(30); }

  public static string Move(int x, int y) { To(x, y); return "true"; }

  public static string Click(int x, int y, bool here, string button, int count) {
    if (!here) To(x, y);
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; } else if (button == "middle") { down = 0x0020; up = 0x0040; }
    for (int i = 0; i < Math.Max(1, count); i++) { Send(MouseIn(down, 0)); Thread.Sleep(20); Send(MouseIn(up, 0)); if (i + 1 < count) Thread.Sleep(70); }
    return "true";
  }

  public static string Drag(int x1, int y1, int x2, int y2) {
    To(x1, y1); Send(MouseIn(0x0002, 0)); Thread.Sleep(120);
    for (int s = 1; s <= 12; s++) { SetCursorPos(x1 + (x2 - x1) * s / 12, y1 + (y2 - y1) * s / 12); Thread.Sleep(25); }
    Thread.Sleep(100); Send(MouseIn(0x0004, 0));
    return "true";
  }

  public static string Scroll(int x, int y, int dy, int dx) {
    To(x, y);
    if (dy != 0) Send(MouseIn(0x0800, dy * 120));
    if (dx != 0) Send(MouseIn(0x1000, dx * 120));
    return "true";
  }

  static readonly HashSet<int> Ext = new HashSet<int> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5 };
  static void Down(int vk) { Send(KeyIn((ushort)vk, 0, Ext.Contains(vk) ? 1u : 0u)); }
  static void Up(int vk) { Send(KeyIn((ushort)vk, 0, (Ext.Contains(vk) ? 1u : 0u) | 2u)); }

  public static string TypeText(string text) {
    foreach (char c in text ?? "") {
      if (c == '\r') continue;
      if (c == '\n') { Down(0x0D); Up(0x0D); continue; }
      if (c == '\t') { Down(0x09); Up(0x09); continue; }
      Send(KeyIn(0, c, 0x0004), KeyIn(0, c, 0x0004 | 0x0002));
      Thread.Sleep(3);
    }
    return "true";
  }

  public static string Keys(string spec) {
    foreach (var combo in spec.Split('|')) {
      var held = new List<int>();
      try {
        foreach (var part in combo.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
          int code = int.Parse(part.Substring(1));
          int vk = code;
          if (part[0] == 'c') {
            short r = VkKeyScan((char)code);
            if (r == -1) throw new Exception("No key for the character " + (char)code);
            vk = r & 0xff;
            int st = (r >> 8) & 0xff;
            if ((st & 1) != 0 && !held.Contains(0x10)) { Down(0x10); held.Add(0x10); }
            if ((st & 2) != 0 && !held.Contains(0x11)) { Down(0x11); held.Add(0x11); }
            if ((st & 4) != 0 && !held.Contains(0x12)) { Down(0x12); held.Add(0x12); }
          }
          Down(vk); held.Add(vk);
          Thread.Sleep(15);
        }
      } finally {
        for (int i = held.Count - 1; i >= 0; i--) { Up(held[i]); Thread.Sleep(5); }
      }
      Thread.Sleep(40);
    }
    return "true";
  }

  public static string CursorPos() { POINT p; GetCursorPos(out p); return "{\"x\":" + p.X + ",\"y\":" + p.Y + "}"; }
}
'@
[HollyDesk]::Init()
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if ($line.Trim() -eq '') { continue }
  $id = 0
  try {
    $c = $line | ConvertFrom-Json
    $id = [int]$c.id
    switch ($c.op) {
      'info'   { $r = [HollyDesk]::Info() }
      'shot'   { $r = [HollyDesk]::Shot([int]$c.maxWidth, [int]$c.quality) }
      'move'   { $r = [HollyDesk]::Move([int]$c.x, [int]$c.y) }
      'click'  { $r = [HollyDesk]::Click([int]$c.x, [int]$c.y, [bool]$c.here, [string]$c.button, [int]$c.count) }
      'drag'   { $r = [HollyDesk]::Drag([int]$c.x, [int]$c.y, [int]$c.x2, [int]$c.y2) }
      'scroll' { $r = [HollyDesk]::Scroll([int]$c.x, [int]$c.y, [int]$c.dy, [int]$c.dx) }
      'type'   { $r = [HollyDesk]::TypeText([string]$c.text) }
      'keys'   { $r = [HollyDesk]::Keys([string]$c.spec) }
      'cursor' { $r = [HollyDesk]::CursorPos() }
      default  { throw ('Unknown op ' + $c.op) }
    }
    [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"result":' + $r + '}')
  } catch {
    [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"error":' + [HollyDesk]::Q($_.Exception.Message) + '}')
  }
}
`;

class WindowsDesktop {
  constructor({ log }) {
    this.log = log;
    this.proc = null;
    this.ready = null;
    this.seq = 0;
    this.pending = new Map();
    this.cached = null;
  }

  async init() {
    return this;
  }

  start() {
    if (this.ready) return this.ready;
    const dir = mkdtempSync(join(os.tmpdir(), 'holly-desktop-'));
    const script = join(dir, 'holly-desktop.ps1');
    writeFileSync(script, WINDOWS_HOST, 'utf8');
    this.dir = dir;
    const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    let buf = '';
    let errText = '';
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The Windows screen helper took too long to start.')), 45000);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.ready) {
            clearTimeout(timer);
            resolve();
            continue;
          }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error || 'Screen helper error'));
        }
      });
      proc.stderr.on('data', (d) => {
        errText = `${errText}${d}`.slice(-2000);
      });
      const fail = (why) => {
        clearTimeout(timer);
        const err = new Error(`${why}${errText ? `: ${errText.trim().split('\n').slice(-3).join(' ')}` : ''}`);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        reject(err);
      };
      proc.on('error', (err) => fail(`Could not start PowerShell (${err.message})`));
      proc.on('exit', (code) => fail(`The Windows screen helper stopped (${code})`));
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  async call(op, args = {}, timeoutMs = 30000) {
    await this.start();
    const id = ++this.seq;
    // ASCII-only line so the console code page can't mangle text.
    const line = JSON.stringify({ id, op, ...args }).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The screen helper did not finish "${op}" in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${line}\n`);
    });
  }

  async info() {
    if (this.cached && Date.now() - this.cachedAt < INFO_TTL) return this.cached;
    const notes = [];
    let width = 0;
    let height = 0;
    try {
      ({ width, height } = await this.call('info'));
    } catch (err) {
      notes.push(`Screen control unavailable: ${err.message}`);
    }
    notes.push('Bots can\'t click inside windows that run as administrator unless Holli Bot Computer runs as administrator too.');
    this.cached = { width, height, screenshotAvailable: width > 0, inputAvailable: width > 0, notes };
    this.cachedAt = Date.now();
    return this.cached;
  }

  async screenshot({ maxWidth = 1280, quality = 70 } = {}) {
    try {
      return await this.call('shot', { maxWidth, quality });
    } catch (err) {
      if (/handle is invalid|CopyFromScreen/i.test(err.message)) throw new Error('Could not capture the screen — the computer may be locked or asleep.');
      throw err;
    }
  }

  move(x, y) {
    return this.call('move', { x, y });
  }

  click(x, y, { button = 'left', double = false } = {}) {
    const here = !(Number.isFinite(x) && Number.isFinite(y));
    return this.call('click', { x: here ? 0 : x, y: here ? 0 : y, here, button, count: double ? 2 : 1 });
  }

  drag(x1, y1, x2, y2) {
    return this.call('drag', { x: x1, y: y1, x2, y2 });
  }

  type(text) {
    return this.call('type', { text: String(text || '') }, 15000 + String(text || '').length * 20);
  }

  key(spec) {
    return this.call('keys', { spec: windowsKeySpec(spec) });
  }

  scroll(x, y, { direction = 'down', amount = 5 } = {}) {
    const n = Math.max(1, Math.min(50, amount));
    const dy = direction === 'up' ? n : direction === 'down' ? -n : 0;
    const dx = direction === 'right' ? n : direction === 'left' ? -n : 0;
    return this.call('scroll', { x, y, dy, dx });
  }

  cursor() {
    return this.call('cursor');
  }

  async close() {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    try {
      proc?.stdin.end();
      proc?.kill();
    } catch { /* gone */ }
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}

/** `region`: on Linux, a part of the display that's all this desktop sees and
 * acts on ({ x, y, width, height }: a bot's own screen, computer/src/screens.mjs). */
export async function createDesktop({ log = console, platform = process.platform, env = process.env, region = null } = {}) {
  if (platform === 'win32') return new WindowsDesktop({ log }).init();
  if (platform === 'darwin') return new MacDesktop({ log }).init();
  return new LinuxDesktop({ log, env, region }).init();
}
