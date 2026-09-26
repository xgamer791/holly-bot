import { truncate, truncateMiddle } from '../util.js';
import { isSafeCommand } from '../computer.js';
import { guessMime } from '../files.js';
import { phrase, spoken } from '../i18n.js';

// Tools that act on the Bot Computer (the user's own PC/Mac/Linux box running
// Holly Bot Computer). With Auto-review on, actions that change things ask for
// approval first — once per task for screen/browser control, per command for shell.

const connected = (app) => !!app.computer?.connected;
const caps = (app) => app.computer?.info?.capabilities || {};

const DESKTOP_ACTIONS = ['screenshot', 'click', 'double_click', 'right_click', 'move', 'drag', 'type', 'key', 'scroll', 'wait', 'cursor'];
const BROWSER_ACTIONS = ['goto', 'snapshot', 'click', 'type', 'type_text', 'press', 'scroll', 'back', 'forward', 'reload', 'tabs', 'new_tab', 'switch_tab', 'close_tab', 'screenshot', 'click_xy'];

function osHint(app) {
  const p = app.computer?.info?.platform;
  return p === 'win32' ? 'Windows (use ctrl for shortcuts, win key for Start)' : p === 'darwin' ? 'macOS (use cmd for shortcuts, cmd+space for Spotlight)' : 'Linux';
}

export const computerTools = [
  {
    name: 'computer',
    group: 'computer',
    available: (app) => connected(app) && (caps(app).desktop || caps(app).screenshot),
    label: (a) => (a.action === 'screenshot' ? phrase('Looked at the screen')
      : a.action === 'type' ? phrase('Typed “{text}”', { text: truncate(a.text || '', 40) })
        : a.action === 'key' ? phrase('Pressed {keys}', { keys: a.keys })
          : a.action === 'click' ? phrase('click at {x}, {y}', { x: a.x, y: a.y })
            : a.action === 'double_click' ? phrase('double click at {x}, {y}', { x: a.x, y: a.y })
              : a.action === 'right_click' ? phrase('right click at {x}, {y}', { x: a.x, y: a.y })
                : `${a.action}`),
    description: 'Use the computer like a person: see the screen and control the mouse and keyboard. '
      + 'Actions: screenshot; click / double_click / right_click {x, y}; move {x, y}; drag {x, y, to_x, to_y}; type {text}; key {keys, e.g. "ctrl+c", "cmd+space", "enter", "alt+tab"}; scroll {x, y, direction: up|down|left|right, amount}; wait {seconds}; cursor. '
      + 'Coordinates are pixels in the latest screenshot. Every action returns a fresh screenshot so you can check the result — look before you click, and verify after. '
      + 'For websites prefer the browser tool (more reliable), for files/programs prefer shell; use this for desktop apps and anything visual.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: DESKTOP_ACTIONS },
        x: { type: 'integer' },
        y: { type: 'integer' },
        to_x: { type: 'integer' },
        to_y: { type: 'integer' },
        text: { type: 'string' },
        keys: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', minimum: 1, maximum: 30 },
        seconds: { type: 'number', minimum: 0.2, maximum: 30 },
      },
      required: ['action'],
    },
    risk: (a) => (['screenshot', 'wait', 'cursor', 'move'].includes(a.action) ? 'low' : 'high'),
    approvalScope: 'turn',
    approval: () => 'Control your computer’s mouse and keyboard for this task',
    async run(args, ctx) {
      // On a server, each bot's own screen (computer/src/screens.mjs).
      const r = await ctx.app.computer.desktopAction(args.action, { ...args, agentId: ctx.agent.id }, { signal: ctx.signal });
      ctx.app.logActivity(ctx.agent.id, { type: 'desktop', ...titled(safeLabel(this, args)), detail: '' });
      if (args.action === 'cursor') return { content: `Cursor at ${r.cursor?.x}, ${r.cursor?.y}.` };
      const shot = r.screenshot;
      return {
        content: `${args.action === 'screenshot' ? 'Screenshot' : `Did ${args.action}; new screenshot`} (${shot?.width}×${shot?.height}, ${osHint(ctx.app)}).`,
        images: shot?.data ? [{ mime: shot.mime || 'image/jpeg', data: shot.data }] : [],
        display: { kind: 'screenshot', action: args.action },
      };
    },
  },
  {
    name: 'browser',
    group: 'computer',
    available: (app) => connected(app) && caps(app).browser,
    label: (a) => phrase('Browser: {action}', { action: `${a.action.replace('_', ' ')}${a.url ? ` ${truncate(a.url, 40)}` : a.ref ? ` ${a.ref}` : ''}` }),
    description: 'Drive a real Chrome browser on the computer (its own profile, so logins persist). You get your own tab. Pages come back as text with numbered element refs like [e12] — use them to click and type. '
      + 'Actions: goto {url}; snapshot; click {ref | text | selector}; type {ref | selector, text, submit?} (also picks an option in a select); type_text {text} (into the focused field); press {key: Enter, Tab, Escape, ArrowDown, Control+a…}; scroll {direction}; back; forward; reload; tabs; new_tab {url}; switch_tab {id}; close_tab {id}; screenshot; click_xy {x, y} (pixels in the last screenshot). '
      + 'Refs change when the page changes — use the ones from the latest result. Dialogs are accepted automatically and downloads go to the Downloads folder in the workspace. '
      + 'If a site needs the user to sign in or solve a CAPTCHA, tell them — they can do it from the Computer panel on their phone — then continue.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: BROWSER_ACTIONS },
        url: { type: 'string' },
        ref: { type: 'string', description: 'Element ref from the last page text, e.g. "e12".' },
        text: { type: 'string' },
        selector: { type: 'string' },
        key: { type: 'string' },
        submit: { type: 'boolean' },
        direction: { type: 'string', enum: ['up', 'down'] },
        id: { type: 'string', description: 'Tab id (from tabs).' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['action'],
    },
    risk: (a) => (['click', 'type', 'type_text', 'press', 'click_xy'].includes(a.action) ? 'high' : 'low'),
    approvalScope: 'turn',
    approval: () => 'Use the browser on your computer (click and type on websites) for this task',
    async run(args, ctx) {
      const { action, ...rest } = args;
      const extra = action === 'click_xy' ? { withScreenshot: true } : {};
      const r = await ctx.app.computer.browser(action, { ...rest, ...extra, agentId: ctx.agent.id }, { signal: ctx.signal });
      ctx.app.logActivity(ctx.agent.id, { type: 'browser', title: `${action}${args.url ? ` ${args.url}` : ''}`, detail: truncate(r.text || r.title || '', 300) });
      const images = r.screenshot ? [{ mime: 'image/jpeg', data: r.screenshot }] : [];
      const tabs = r.tabs ? r.tabs.map((t) => `${t.active ? '* ' : '  '}${t.id}  ${t.title} — ${t.url}`).join('\n') : '';
      return {
        content: [r.note, tabs, r.result !== undefined ? `result: ${JSON.stringify(r.result)}` : '', r.text ? truncateMiddle(r.text, 24000) : (r.url ? `${r.title || ''} — ${r.url}` : '')].filter(Boolean).join('\n') || 'Done.',
        images,
        display: { kind: 'browser', action, url: r.url, title: r.title },
      };
    },
  },
  {
    name: 'shell',
    group: 'computer',
    available: connected,
    label: (a) => truncate(a.command || 'Shell command', 70),
    description: 'Run a command in the computer\'s shell (PowerShell on Windows, bash/zsh on macOS and Linux) and get its output and exit code. '
      + 'Use it for files, installing and running programs, git, scripts (python, node) and system tasks. Prefer non-interactive flags. '
      + 'Set background=true for servers or long jobs (returns a PID and a log file). Commands that change things need the user\'s approval when Auto-review is on.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory (defaults to the Holly workspace folder).' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600 },
        background: { type: 'boolean' },
      },
      required: ['command'],
    },
    risk: (a) => (isSafeCommand(a.command) && !a.background ? 'low' : 'high'),
    approval: (a) => a.command,
    async run(args, ctx) {
      let live = '';
      const res = await ctx.app.computer.exec(args.command, {
        cwd: args.cwd,
        background: !!args.background,
        timeoutMs: (args.timeout_seconds || 180) * 1000,
        signal: ctx.signal,
        onData: (_stream, chunk) => {
          live += chunk;
          ctx.progress?.(truncate(live.split('\n').filter(Boolean).pop() || '', 120));
        },
      });
      ctx.app.logActivity(ctx.agent.id, { type: 'shell', title: args.command, detail: truncateMiddle(`${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}`, 8000), code: res.code });
      const content = [
        `exit code: ${res.code ?? 'unknown'}${res.signal ? ` (signal ${res.signal})` : ''}`,
        res.stdout && `stdout:\n${truncateMiddle(res.stdout, 16000)}`,
        res.stderr && `stderr:\n${truncateMiddle(res.stderr, 6000)}`,
      ].filter(Boolean).join('\n\n');
      return {
        content,
        isError: res.code !== 0,
        display: { kind: 'terminal', command: args.command, stdout: truncateMiddle(res.stdout, 20000), stderr: truncateMiddle(res.stderr, 8000), code: res.code },
      };
    },
  },
  {
    name: 'computer_files',
    group: 'computer',
    available: connected,
    label: (a) => {
      const path = a.path;
      switch (a.op) {
        case 'send': return phrase('Sent {file}', { file: String(a.path).split(/[\\/]/).pop() });
        case 'list': return phrase('Listed {path}', { path });
        case 'read': return phrase('Read {path}', { path });
        case 'write': return phrase('Wrote {path}', { path });
        case 'append': return phrase('Appended to {path}', { path });
        case 'delete': return phrase('Deleted {path}', { path });
        default: return `${a.op} ${a.path}`;
      }
    },
    description: 'Work with files on the computer. ops: list {path}; read {path}; write {path, content}; append {path, content}; delete {path}; send {path} — sends that file to the user\'s phone as an attachment. Paths may be absolute or relative to the Holly workspace folder; ~ is the home folder.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'read', 'write', 'append', 'delete', 'send'] },
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['op', 'path'],
    },
    risk: (a) => (['read', 'list', 'send'].includes(a.op) ? 'low' : 'high'),
    approval: (a) => `${a.op} ${a.path}`,
    async run(args, ctx) {
      const pc = ctx.app.computer;
      if (args.op === 'list') {
        const r = await pc.fs('list', { path: args.path }, { signal: ctx.signal });
        return { content: `${r.path}\n${(r.entries || []).map((e) => `${e.type === 'dir' ? '[dir] ' : ''}${e.name}${e.type === 'file' ? `  (${e.size} B)` : ''}`).join('\n') || '(empty)'}` };
      }
      if (args.op === 'read' || args.op === 'send') {
        const r = await pc.fs('read', { path: args.path }, { signal: ctx.signal });
        if (r.entries) return { content: 'That is a folder; use op list.', isError: true };
        if (args.op === 'send') {
          const name = String(r.path).split(/[\\/]/).pop();
          const mime = r.mime || guessMime(name);
          const content = r.text != null ? r.text : new Blob([Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))], { type: mime });
          const f = await ctx.app.files.write(ctx.agent.id, `from-computer/${name}`, content, { mime });
          return { content: `Sent ${name} to the user.`, display: { kind: 'file', fileId: f.id, name, path: f.path, size: f.size, mime: f.mime } };
        }
        if (r.base64 && r.mime?.startsWith('image/')) return { content: `Image ${r.path} attached.`, images: [{ mime: r.mime, data: r.base64 }] };
        if (r.base64) return { content: `${r.path} is binary (${r.mime}, ${r.size} bytes). Use op send to give it to the user, or shell tools to inspect it.` };
        return { content: truncateMiddle(r.text || '', 48000) };
      }
      if (args.op === 'delete') {
        const r = await pc.fs('delete', { path: args.path }, { signal: ctx.signal });
        ctx.app.logActivity(ctx.agent.id, { type: 'file', title: `delete ${r.path}` });
        return { content: `Deleted ${r.path}.` };
      }
      const r = await pc.fs(args.op === 'append' ? 'append' : 'write', { path: args.path, text: args.content ?? '' }, { signal: ctx.signal });
      ctx.app.logActivity(ctx.agent.id, { type: 'file', title: `${args.op} ${r.path}`, detail: `${r.size} bytes` });
      return { content: `${args.op === 'append' ? 'Appended to' : 'Wrote'} ${r.path} (${r.size} bytes).` };
    },
  },
];

function safeLabel(tool, args) {
  try {
    return tool.label(args);
  } catch {
    return tool.name;
  }
}

/** An activity row's title: the English, and the phrase the app shows
 * translated (`say`) when the label is one. */
function titled(label) {
  const { text, say } = spoken(label);
  return say ? { title: text, say } : { title: text };
}
