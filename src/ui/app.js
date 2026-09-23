import { html, useState, useEffect, useMemo, useRef } from '../../vendor/preact.js';
import { AppCtx, UiCtx, useMedia, useApp, useTopics } from './hooks.js';
import { HomeScreen } from './home.js';
import { ChatScreen } from './chat.js';
import { CreateBotSheet, NewGroupSheet } from './create-bot.js';
import { SettingsSheet } from './settings.js';
import { BotProfileSheet, ModelPickerSheet } from './bot-profile.js';
import { MemorySheet } from './memory.js';
import { ComputerSheet } from './computer.js';
import { RoutinesSheet } from './routines.js';
import { ActivityDrawer, GroupInfoSheet } from './drawer.js';
import { Dialog, Toasts } from './components.js';
import { Icon } from './icons.js';
import { Avatar, avatarSvgString } from './avatar.js';
import { threadTitle } from './home.js';

const SHEETS = {
  createBot: CreateBotSheet,
  newGroup: NewGroupSheet,
  settings: SettingsSheet,
  botProfile: BotProfileSheet,
  modelPicker: ModelPickerSheet,
  memory: MemorySheet,
  computer: ComputerSheet,
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
  const [drawer, setDrawer] = useState(false);
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
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f5f7' : theme === 'dark' ? '#141416' : '#0b0b0b');
  }, [appearance, prefersLight]);

  const ui = useMemo(() => ({
    navigate(href) {
      if (location.hash !== href) location.hash = href;
      else setRoute(parseHash());
    },
    openSheet(name, props = {}) {
      setSheets((s) => [...s.filter((x) => !(x.name === name && name !== 'modelPicker')), { name, props, id: ++sheetSeq.current }]);
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
      return new Promise((resolve) => setDialog({ ...opts, input: { value: opts.value || '', placeholder: opts.placeholder }, onResult: (v) => { setDialog(null); resolve(v); } }));
    },
    async openFile(fileId) {
      const f = await app.files.getById(fileId);
      if (!f) return this.toast('File not found', { error: true });
      this.openSheet('computer', { agentId: f.agentId, fileId });
    },
    regenerate(msg) {
      app.runtime.regenerate(msg.id);
    },
    openDrawer: () => setDrawer(true),
  }), []);

  // Notifications when a bot finishes or needs you while you're elsewhere.
  useEffect(() => app.on('notify', ({ agent, text, threadId }) => {
    if (!app.settings.notifications || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      if (!app.isViewing(threadId) && document.visibilityState === 'visible' && agent) {
        ui.toast(`${agent.name}: ${text}`, { action: { label: 'Open', onClick: () => ui.navigate(`#/chat/${threadId}`) } });
      }
      return;
    }
    if (document.visibilityState === 'visible' && app.isViewing(threadId)) return;
    if (document.visibilityState === 'visible') {
      ui.toast(`${agent?.name || 'Bot'}: ${text}`, { action: { label: 'Open', onClick: () => ui.navigate(`#/chat/${threadId}`) } });
      return;
    }
    const icon = `data:image/svg+xml,${encodeURIComponent(avatarSvgString(agent || {}))}`;
    const opts = { body: text, icon, tag: threadId, data: { threadId } };
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(agent?.name || 'Holly Bot', opts)).catch(() => {
      try {
        new Notification(agent?.name || 'Holly Bot', opts);
      } catch { /* unsupported */ }
    });
  }), []);

  // Service worker notification clicks → open the chat.
  useEffect(() => {
    const on = (e) => e.data?.type === 'open-thread' && ui.navigate(`#/chat/${e.data.threadId}`);
    navigator.serviceWorker?.addEventListener('message', on);
    return () => navigator.serviceWorker?.removeEventListener('message', on);
  }, []);

  // Routine scheduler for bots that live in this browser (one tab at a time when Web Locks exist).
  // When bots live on a Holly Computer, it runs routines 24/7 instead.
  useEffect(() => {
    if (app.remote) return undefined;
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
    document.title = `${unread ? `(${unread}) ` : ''}${t ? `${threadTitle(app, t)} · ` : ''}Holly Bot`;
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
            : wide && html`<div class="pane-chat empty"><div style="text-align:center"><${Avatar} shape="cloud" color="white" size=${84} live /><p>Pick a bot or create a new one.</p></div></div>`}
        </div>
        ${app.remote && html`<${ConnectionBanner} />`}
        <button class="edge-handle" aria-label="Open activity" onClick=${() => setDrawer(true)}>
          <${Icon.handle} />
          ${waitingCount > 0 && html`<span class="badge">${waitingCount}</span>`}
        </button>
        ${sheets.map((s) => {
          const C = SHEETS[s.name];
          return C ? html`<${C} key=${s.id} ...${s.props} onClose=${() => ui.closeSheet(s.id)} />` : null;
        })}
        ${drawer && html`<${ActivityDrawer} onClose=${() => setDrawer(false)} />`}
        ${dialog && html`<${Dialog} ...${dialog} />`}
        <${Toasts} toasts=${toasts} onDismiss=${(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      <//>
    <//>`;
}

/** Remote mode: shows when the phone can't reach Holly Computer (it keeps retrying). */
function ConnectionBanner() {
  const app = useApp();
  useTopics(['connection']);
  if (app.connection !== 'offline') return null;
  return html`<div class="conn-banner" role="status"><span class="spinner"></span> Can't reach ${app.server?.name || 'your computer'} — reconnecting…</div>`;
}
