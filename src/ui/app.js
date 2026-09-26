import { html, useState, useEffect, useMemo, useRef } from '../../vendor/preact.js';
import { AppCtx, UiCtx, useMedia } from './hooks.js';
import { HomeScreen } from './home.js';
import { ChatScreen } from './chat.js';
import { CreateBotSheet, NewGroupSheet } from './create-bot.js';
import { SettingsSheet } from './settings.js';
import { BotProfileSheet, ModelPickerSheet } from './bot-profile.js';
import { MemorySheet } from './memory.js';
import { ComputerSheet } from './computer.js';
import { WorkspaceSheet } from './workspace.js';
import { RoutinesSheet } from './routines.js';
import { GroupInfoSheet } from './group-info.js';
import { Dialog, Toasts } from './components.js';
import { Avatar, avatarSvgString } from './avatar.js';
import { threadTitle } from './home.js';
import { phraseOr, tr } from './i18n.js';
import { deviceName } from '../remote/remote-app.js';

const SHEETS = {
  createBot: CreateBotSheet,
  newGroup: NewGroupSheet,
  settings: SettingsSheet,
  botProfile: BotProfileSheet,
  modelPicker: ModelPickerSheet,
  memory: MemorySheet,
  computer: ComputerSheet,
  workspace: WorkspaceSheet,
  routines: RoutinesSheet,
  groupInfo: GroupInfoSheet,
};

function parseHash() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/chat\/([^/?]+)/);
  return { threadId: m ? decodeURIComponent(m[1]) : null };
}

export function Root({ app }) {
  const [route, setRoute] = useState(parseHash);
  const [sheets, setSheets] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [, setTick] = useState(0);
  const wide = useMedia('(min-width: 900px)');
  const prefersLight = useMedia('(prefers-color-scheme: light)');
  const sheetSeq = useRef(0);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  // Re-render on settings changes (theme etc.) and for waiting-count badge.
  useEffect(() => {
    const offs = ['settings', 'threads'].map((t) => app.on(t, () => setTick((x) => x + 1)));
    return () => offs.forEach((o) => o());
  }, []);

  const appearance = app.settings.appearance || 'system';
  useEffect(() => {
    const theme = appearance === 'system' ? (prefersLight ? 'light' : 'black') : appearance;
    if (theme === 'black') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    // Browser and status bar chrome use the app background, so there's no seam.
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  }, [appearance, prefersLight]);

  const ui = useMemo(() => ({
    navigate(href) {
      if (location.hash !== href) location.hash = href;
      else setRoute(parseHash());
    },
    openSheet(name, props = {}) {
      const id = ++sheetSeq.current;
      setSheets((s) => [...s.filter((x) => !(x.name === name && name !== 'modelPicker')), { name, props, id }]);
      return id;
    },
    closeSheet(id) {
      setSheets((s) => (id ? s.filter((x) => x.id !== id) : s.slice(0, -1)));
    },
    toast(text, opts = {}) {
      const id = Math.random().toString(36).slice(2);
      setToasts((t) => [...t.slice(-2), { id, text, ...opts }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.error ? 6000 : 2600);
    },
    confirm(opts) {
      return new Promise((resolve) => setDialog({ ...opts, onResult: (v) => { setDialog(null); resolve(!!v); } }));
    },
    prompt(opts) {
      return new Promise((resolve) => setDialog({ ...opts, input: { value: opts.value || '', placeholder: opts.placeholder, type: opts.type }, onResult: (v) => { setDialog(null); resolve(v); } }));
    },
    async openFile(fileId) {
      const f = await app.files.getById(fileId);
      if (!f) return this.toast(tr('File not found'), { error: true });
      this.openSheet('computer', { agentId: f.agentId, fileId });
    },
    regenerate(msg) {
      app.runtime.regenerate(msg.id);
    },
  }), []);

  // Notifications when a bot finishes or needs you while you're elsewhere.
  useEffect(() => app.on('notify', ({ agent, text, threadId, say }) => {
    if (!app.settings.notifications || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      if (!app.isViewing(threadId) && document.visibilityState === 'visible' && agent) {
        ui.toast(`${agent.name}: ${phraseOr(say, text)}`, { action: { label: tr('Open'), onClick: () => ui.navigate(`#/chat/${threadId}`) } });
      }
      return;
    }
    if (document.visibilityState === 'visible' && app.isViewing(threadId)) return;
    if (document.visibilityState === 'visible') {
      ui.toast(`${agent?.name || tr('Bot')}: ${phraseOr(say, text)}`, { action: { label: tr('Open'), onClick: () => ui.navigate(`#/chat/${threadId}`) } });
      return;
    }
    const icon = `data:image/svg+xml,${encodeURIComponent(avatarSvgString(agent || {}))}`;
    const opts = { body: phraseOr(say, text), icon, tag: threadId, data: { threadId } };
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(agent?.name || 'Holli Bot', opts)).catch(() => {
      try {
        new Notification(agent?.name || 'Holli Bot', opts);
      } catch { /* unsupported */ }
    });
  }), []);

  // Something to say once the app is open, such as how connecting Gmail,
  // Outlook or GitHub went (src/main.js), and where to look.
  useEffect(() => {
    const notice = app.startupNotice;
    if (!notice) return;
    app.startupNotice = null;
    if (notice.page) ui.openSheet('settings', { page: notice.page });
    ui.toast(notice.text, { error: !!notice.error });
  }, []);

  // Service worker notification clicks → open the chat.
  useEffect(() => {
    const on = (e) => e.data?.type === 'open-thread' && ui.navigate(`#/chat/${e.data.threadId}`);
    navigator.serviceWorker?.addEventListener('message', on);
    return () => navigator.serviceWorker?.removeEventListener('message', on);
  }, []);

  // A computer linked to the account came on (watchComputers in src/main.js):
  // ask whether this app should use it. Not while another question is open.
  // Connecting reloads the app on it; if it doesn't answer, this says why.
  const asking = useRef(false);
  asking.current = !!dialog;
  useEffect(() => app.on('computer-offer', async (offer) => {
    if (asking.current) return offer.later();
    const yes = await ui.confirm({
      title: tr('Connect to {name}?', { name: offer.name }),
      message: tr('{name} is on. Connect, and your bots run there, using its apps, files, browser, screen, mouse and keyboard.', { name: offer.name }),
      confirmText: tr('Connect'),
      cancelText: tr('Not now'),
    });
    if (!yes) return offer.decline();
    ui.toast(tr('Connecting to {name}…', { name: offer.name }));
    offer.accept().catch((err) => ui.toast(err?.message || tr("Couldn't connect to {name}.", { name: offer.name }), { error: true }));
    return undefined;
  }), []);

  // What src/main.js has to say while the app is open (connecting to a computer).
  useEffect(() => app.on('toast', ({ text, error }) => ui.toast(text, { error: !!error })), []);

  // On Holli Bot Computer's own page: a phone just connected to this computer
  // (computer/src/server.mjs hello). The first time (Connect), a word to
  // confirm it; after that, when it connects by itself, a quieter one.
  useEffect(() => app.on('hello', (hello) => {
    if (!app.ownPage || !hello || hello.clientId === app.clientId) return;
    const device = deviceName(hello.kind);
    const name = app.server?.name || tr('this computer');
    if (!hello.first) {
      ui.toast(tr('Holli Bot on your {device} connected to {name}.', { device, name }));
      return;
    }
    ui.confirm({
      title: tr('Connected to your {device}', { device }),
      message: tr('Holli Bot on your {device} is connected to {name}. Your bots run here, and you can use them from your {device}.', { device, name }),
      confirmText: tr('OK'),
      cancelText: null,
    });
  }), []);

  // Routine scheduler for bots that run in this app (one tab at a time when Web Locks exist).
  // When a Holli Bot Computer runs them (this app controls it, or it's linked to
  // the account), it runs routines 24/7 instead.
  useEffect(() => {
    if (app.remote || app.linkedComputers?.length) return undefined;
    app.startScheduler({
      lock: navigator.locks?.request ? (fn) => navigator.locks.request('holly-routines', { ifAvailable: true }, (l) => (l ? fn() : null)) : null,
    });
    const onVis = () => document.visibilityState === 'visible' && app.schedulerKick?.();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      app.stopScheduler();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Title shows what needs attention.
  const waitingCount = app.listThreads().filter((t) => t.status === 'waiting').length;
  const unread = app.listThreads().filter((t) => t.unread).length;
  useEffect(() => {
    const t = route.threadId && app.getThread(route.threadId);
    document.title = `${unread ? `(${unread}) ` : ''}${t ? `${threadTitle(app, t)} · ` : ''}Holli Bot`;
    navigator.setAppBadge?.(unread + waitingCount).catch?.(() => {});
  });

  const inChat = !!route.threadId;
  return html`
    <${AppCtx.Provider} value=${app}>
      <${UiCtx.Provider} value=${ui}>
        <div class=${`app ${wide ? 'wide' : 'mobile'} ${inChat ? 'in-chat' : ''}`}>
          <${HomeScreen} activeThreadId=${route.threadId} />
          ${inChat
            ? html`<${ChatScreen} key=${route.threadId} threadId=${route.threadId} wide=${wide} />`
            : wide && html`<div class="pane-chat empty"><div style="text-align:center"><${Avatar} shape="cloud" color="blue" size=${84} live /><p>${tr('Pick a bot or create a new one.')}</p></div></div>`}
        </div>
        ${sheets.map((s) => {
          const C = SHEETS[s.name];
          return C ? html`<${C} key=${s.id} ...${s.props} onClose=${() => ui.closeSheet(s.id)} />` : null;
        })}
        ${dialog && html`<${Dialog} ...${dialog} />`}
        <${Toasts} toasts=${toasts} onDismiss=${(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      <//>
    <//>`;
}
