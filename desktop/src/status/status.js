// Holli Bot for Windows' settings window: how Holli Bot Computer is doing (Status),
// its settings (Settings) and what it says as it works (Activity). Everything
// comes from the app (main.js, through preload.cjs), and everything it does
// goes through it.

import qrcode from 'qrcode-generator';
import { mark } from '../../../src/core/i18n.js';
import { setLanguage, tr } from '../i18n.js';

const { holly } = window;
const $ = (id) => document.getElementById(id);

let view = null;
let tab = 'status';
let lines = [];
const controls = {};

/** An element: h('div', { class: 'card', onclick }, ...children). */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else if (value !== false) el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const act = (action, arg) => holly.act(action, arg);

function statusWords(status) {
  return {
    starting: tr('Starting…'),
    restarting: tr('Restarting…'),
    running: tr('Running'),
    stopping: tr('Stopping…'),
    stopped: tr('Stopped'),
    failed: tr("Couldn't start"),
  }[status] || '';
}

// ----- the top: name, status, Open Holli Bot, Restart ------------------------------------

function renderTop() {
  const s = view.state;
  $('sub').textContent = s
    ? tr('{name} · Holli Bot Computer {version}', { name: s.name, version: s.version })
    : view.version ? `Holli Bot Computer ${view.version}` : '';
  const pill = $('pill');
  pill.className = `pill ${{ running: 'ok', starting: 'busy', restarting: 'busy', stopping: 'busy', failed: 'bad' }[view.status] || ''}`;
  $('pill-text').textContent = statusWords(view.status);
  const open = $('open');
  open.textContent = tr('Open Holli Bot');
  open.disabled = !(view.status === 'running' && s);
  const run = $('run');
  if (view.status === 'running') {
    run.textContent = tr('Restart');
    run.disabled = false;
    run.onclick = () => act('restart');
  } else if (view.status === 'stopped' || view.status === 'failed') {
    run.textContent = tr('Start');
    run.disabled = false;
    run.onclick = () => act('start');
  } else {
    run.textContent = statusWords(view.status);
    run.disabled = true;
    run.onclick = null;
  }
}

function renderBanners() {
  const out = [];
  if (view.update) {
    out.push(h('div', { class: 'banner info' },
      h('p', null, view.update.auto
        ? tr('Holli Bot for Windows {version} is ready. It installs itself once no bot is working.', { version: view.update.version })
        : tr('Holli Bot for Windows {version} is ready.', { version: view.update.version })),
      h('button', { class: 'btn small primary', onclick: () => act('update') }, tr('Restart to update'))));
  }
  if (view.restartToApply) {
    out.push(h('div', { class: 'banner warn' },
      h('p', null, tr('Restart Holli Bot Computer to use your new settings.')),
      h('button', { class: 'btn small', onclick: () => act('apply') }, tr('Restart now'))));
  }
  if (view.status === 'failed' && view.error) {
    const e = view.error;
    const text = e.kind === 'port'
      ? tr('Port {port} is in use, so Holli Bot Computer can’t start. It may already be running on this computer, in a terminal: close that, then press Start. Or choose another port in Settings.', { port: e.port })
      : e.kind === 'missing'
        ? tr('Holli Bot Computer’s files are missing. Install Holli Bot for Windows again.')
        : tr('Holli Bot Computer stopped: {detail}. The Activity tab shows what happened.', { detail: e.detail || '' });
    out.push(h('div', { class: 'banner bad' }, h('p', null, text)));
  }
  $('banners').replaceChildren(...out);
}

// ----- Status ----------------------------------------------------------------------------

const CAN = [
  ['shell', mark('Shell')],
  ['files', mark('Files')],
  ['fetch', mark('Web')],
  ['screenshot', mark('Screen')],
  ['desktop', mark('Mouse and keyboard')],
  ['browser', mark('Chrome')],
  ['mcp', mark('Plugins')],
];

/** Where your phone reaches this computer, in words. */
function phoneWords(s) {
  switch (s.tunnel) {
    case 'up': return tr('Your phone can reach this computer from anywhere, through a secure tunnel.');
    case 'starting': return tr('Opening a secure tunnel so your phone can reach this computer…');
    case 'blocked': return tr("This network blocks the secure tunnel Holli Bot Computer uses (Cloudflare Tunnel, outbound port 7844, UDP and TCP), so your phone can't reach this computer. Allow it, use another network, or give this computer your own address in Settings. Holli Bot Computer keeps trying.");
    case 'own': return tr('Your phone reaches this computer at your own address, {address}.', { address: s.address || '' });
    default: return tr("The secure tunnel is off, so your phone can't reach this computer. Turn it on in Settings, or give this computer your own address there.");
  }
}

let qr = null;
/** The Wi-Fi link as a code a phone's camera reads. */
function qrImage(text) {
  if (qr?.text !== text) {
    const code = qrcode(0, 'M');
    code.addData(text);
    code.make();
    qr = { text, url: code.createDataURL(5, 2) };
  }
  return qr.url;
}

function folderRow(title, path, which) {
  return h('div', { class: 'folder' },
    h('div', { class: 'what' }, h('div', { class: 't' }, title), h('div', { class: 'path' }, path || '')),
    h('button', { class: 'btn small', onclick: () => act('folder', which) }, tr('Open')));
}

function renderStatus() {
  const s = view.state;
  const page = $('page-status');
  if (!s) {
    const words = view.status === 'stopped' ? tr('Holli Bot Computer isn’t running. Press Start to run it.')
      : view.status === 'failed' ? tr('Holli Bot Computer isn’t running.')
        : tr('Holli Bot Computer is starting. It can take a minute the first time.');
    page.replaceChildren(h('div', { class: 'card' }, h('p', null, words)));
    return;
  }
  const reachable = s.tunnel === 'up' || s.tunnel === 'own';
  // Through h(), which leaves out what isn't there (no Wi-Fi link: null).
  page.replaceChildren(...h('div', null,
    h('div', { class: 'label' }, tr('Your bots')),
    h('div', { class: 'card' }, s.linked
      ? h('p', null, tr('Your bots are kept in your Holli Bot account, and this computer runs them around the clock.'))
      : [
        h('p', null, tr('Sign in on the Holli Bot window with the Apple or Google account you use in Holli Bot. That links this computer to your account, and your bots run here.')),
        h('button', { class: 'btn primary', onclick: () => act('open') }, tr('Sign In')),
      ]),
    h('div', { class: 'label' }, tr('Your phone')),
    h('div', { class: 'card' },
      h('p', null, phoneWords(s)),
      reachable && h('p', null, s.linked
        ? tr('Holli Bot on your phone, signed in to your account, connects to this computer by itself. The first time, it asks you to tap Connect.')
        : tr('Once this computer is linked to your account, open Holli Bot on your phone and tap Connect.'))),
    s.wifi && [
      h('div', { class: 'label' }, tr('Wi-Fi link')),
      h('div', { class: 'card' }, h('div', { class: 'wifi' },
        h('img', { src: qrImage(s.wifi), alt: '' }),
        h('div', null,
          h('p', null, tr('On a phone on the same Wi-Fi, without signing in, scan this code or open the link:')),
          h('div', { class: 'path' }, s.wifi),
          h('p', { class: 'note' }, tr('Keep that link private, like a password: anyone who has it can control this computer and see your bots, chats and files.'))))),
    ],
    h('div', { class: 'label' }, tr('Bots can use')),
    h('div', { class: 'card' },
      h('div', { class: 'can' }, CAN.map(([key, label]) => {
        const yes = !!s.can?.[key];
        return h('span', { class: `chip${yes ? '' : ' off'}` }, h('span', { class: 'mark' }, yes ? '✓' : '✗'), tr(label));
      })),
      // Holli Bot Computer's own notes (how to let bots use the screen), as it words them.
      s.notes?.length > 0 && h('div', { class: 'note', lang: 'en' }, s.notes.map((note) => h('p', null, note)))),
    h('div', { class: 'label' }, tr('Folders')),
    h('div', { class: 'card' },
      folderRow(tr('Workspace'), s.workspace, 'workspace'),
      folderRow(tr('Data'), s.dataDir, 'data')),
  ).childNodes);
}

// ----- Settings ----------------------------------------------------------------------------

const TOGGLES = [
  ['startWithWindows', mark('Start with Windows'), mark('Holli Bot Computer starts in the taskbar’s corner when you sign in to Windows, so your bots are always at work.')],
  ['keepAwake', mark('Keep this computer awake'), mark('While Holli Bot Computer runs, so your phone can always reach it and bots can finish their work.')],
  ['tunnel', mark('Secure tunnel'), mark('Your phone reaches this computer from anywhere, through Cloudflare’s free quick tunnel.')],
  ['lan', mark('Wi-Fi link'), mark('Phones on the same Wi-Fi connect without signing in, with a link and a code on the Status tab.')],
  ['headlessBrowser', mark('Hide the bots’ browser'), mark('The bots’ Chrome runs without a window. They still browse.')],
  ['update', mark('Keep Holli Bot Computer up to date'), mark('It gets the latest Holli Bot Computer as it starts. Newer versions, of it and of this app, install themselves once no bot is working.')],
];

function toggleRow(key, title, sub) {
  const input = h('input', { type: 'checkbox', role: 'switch', onchange: (e) => act('set', { [key]: e.currentTarget.checked }) });
  controls[key] = input;
  return h('div', { class: 'row' },
    h('div', { class: 'what' }, h('div', { class: 't' }, tr(title)), h('div', { class: 's' }, tr(sub))),
    h('label', { class: 'switch', title: tr(title) }, input, h('span', { class: 'track' })));
}

function folderSetting(key, title, sub) {
  const path = h('div', { class: 'path' });
  const reset = h('button', { class: 'btn small', onclick: () => act('set', { [key]: '' }) }, tr('Use the default'));
  controls[key] = { path, reset };
  return h('div', { class: 'row stack' },
    h('div', { class: 'what' }, h('div', { class: 't' }, title), h('div', { class: 's' }, sub)),
    path,
    h('div', { class: 'can' },
      h('button', { class: 'btn small', onclick: () => act('pick', key) }, tr('Change…')),
      reset));
}

function buildSettings() {
  const address = h('input', {
    class: 'input',
    type: 'url',
    placeholder: 'https://…',
    spellcheck: false,
    onchange: (e) => {
      const url = e.currentTarget.value.trim();
      const ok = !url || /^https:\/\/[^\s/]+/i.test(url);
      address.classList.toggle('bad', !ok);
      addressError.hidden = ok;
      if (ok) act('set', { publicUrl: url });
    },
    onkeydown: (e) => e.key === 'Enter' && e.currentTarget.blur(),
  });
  const addressError = h('div', { class: 'error', hidden: true }, tr('Your own address has to start with https://'));
  controls.publicUrl = address;
  const port = h('input', {
    class: 'input port',
    type: 'number',
    min: 1,
    max: 65535,
    onchange: (e) => {
      const n = Math.round(Number(e.currentTarget.value));
      if (n >= 1 && n <= 65535) act('set', { port: n });
      else e.currentTarget.value = view.settings.port;
    },
    onkeydown: (e) => e.key === 'Enter' && e.currentTarget.blur(),
  });
  controls.port = port;
  const [startWithWindows, keepAwake, tunnel, lan, headless, update] = TOGGLES.map(([key, title, sub]) => toggleRow(key, title, sub));
  $('page-settings').replaceChildren(
    h('div', { class: 'rows' }, startWithWindows, keepAwake, update),
    h('div', { class: 'label' }, tr('Your phone')),
    h('div', { class: 'rows' },
      tunnel,
      h('div', { class: 'row stack' },
        h('div', { class: 'what' },
          h('div', { class: 't' }, tr('Your own address')),
          h('div', { class: 's' }, tr('A permanent https address for this computer, like a named Cloudflare Tunnel or Tailscale Funnel pointing at its port. It takes the tunnel’s place.'))),
        address,
        addressError),
      lan),
    h('div', { class: 'label' }, tr('This computer')),
    h('div', { class: 'rows' },
      headless,
      h('div', { class: 'row' },
        h('div', { class: 'what' }, h('div', { class: 't' }, tr('Port')), h('div', { class: 's' }, tr('Where Holli Bot Computer listens on this computer.'))),
        port),
      folderSetting('workspace', tr('Workspace folder'), tr('The folder your bots work in.')),
      folderSetting('data', tr('Data folder'), tr('Holli Bot Computer’s own files: its keys, its link to your account and the bots’ browser. Until this computer is linked to your account, its bots are kept here too.'))),
    h('div', { class: 'label' }, tr('Keys')),
    h('div', { class: 'rows' },
      h('div', { class: 'row' },
        h('div', { class: 'what' }, h('div', { class: 't' }, tr('New keys')), h('div', { class: 's' }, tr('If a link to this computer got out: links from before stop working.'))),
        h('button', { class: 'btn small danger', onclick: () => act('newKeys') }, tr('Make New Keys')))),
  );
}

function renderSettings() {
  const s = view.settings;
  for (const [key] of TOGGLES) {
    const input = controls[key];
    if (!input || document.activeElement === input) continue;
    input.checked = key === 'startWithWindows' ? !!view.startWithWindows : !!s[key];
  }
  // Your own address takes the tunnel's place.
  controls.tunnel.disabled = !!s.publicUrl;
  if (document.activeElement !== controls.publicUrl) controls.publicUrl.value = s.publicUrl || '';
  if (document.activeElement !== controls.port) controls.port.value = s.port;
  for (const key of ['workspace', 'data']) {
    controls[key].path.textContent = s[key] || view.defaults[key];
    controls[key].reset.hidden = !s[key];
  }
}

// ----- Activity ----------------------------------------------------------------------------

function renderLog() {
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = lines.length ? lines.join('\n') : tr('Nothing yet.');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// ----- the rest ----------------------------------------------------------------------------

function showTab(next) {
  tab = next;
  for (const button of document.querySelectorAll('.tabs button')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  for (const name of ['status', 'settings', 'activity']) $(`page-${name}`).hidden = name !== tab;
  if (tab === 'activity') {
    const log = $('log');
    log.scrollTop = log.scrollHeight;
  }
}

function render() {
  renderTop();
  renderBanners();
  renderStatus();
  renderSettings();
}

async function init() {
  const first = await holly.get();
  if (!first) return;
  view = first;
  lines = first.lines || [];
  setLanguage([view.language]);
  document.documentElement.lang = view.language;
  $('tab-status').textContent = tr('Status');
  $('tab-settings').textContent = tr('Settings');
  $('tab-activity').textContent = tr('Activity');
  $('log-hint').textContent = tr('What Holli Bot Computer says as it works.');
  const copy = $('log-copy');
  copy.textContent = tr('Copy');
  copy.onclick = async () => {
    await act('copy');
    copy.textContent = tr('Copied');
    setTimeout(() => {
      copy.textContent = tr('Copy');
    }, 1500);
  };
  $('log-folder').textContent = tr('Open the log folder');
  $('log-folder').onclick = () => act('folder', 'logs');
  $('open').onclick = () => act('open');
  $('foot-version').textContent = tr('Holli Bot for Windows {version}', { version: view.appVersion });
  $('quit').textContent = tr('Quit Holli Bot');
  $('quit').onclick = () => act('quit');
  for (const button of document.querySelectorAll('.tabs button')) button.onclick = () => showTab(button.dataset.tab);
  buildSettings();
  showTab(tab);
  render();
  renderLog();
  holly.onView((next) => {
    view = next;
    render();
  });
  holly.onLines((more) => {
    lines = [...lines, ...more].slice(-2000);
    renderLog();
  });
}

init();
