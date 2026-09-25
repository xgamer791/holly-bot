import { html, useState, useRef } from '../../vendor/preact.js';
import { useApp, useUi, useTopics, haptic } from './hooks.js';
import { Avatar, AvatarStack, botActivity, thinkingOf } from './avatar.js';
import { Icon } from './icons.js';
import { Popover } from './components.js';
import { initials } from '../core/util.js';
import { chiefOf } from '../core/chief.js';
import { ComputerButton } from './computer-button.js';
import { phraseOr, shortTime, tr } from './i18n.js';

export function HomeScreen({ activeThreadId }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['threads', 'agents', 'runs', 'settings']);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(null);
  const [swiped, setSwiped] = useState(null); // the row swiped open to show Delete
  const plusRef = useRef(null);

  const q = query.trim().toLowerCase();
  const chief = chiefOf(app);
  const chiefChat = (t) => Number(!!chief && t.kind === 'dm' && t.agentIds[0] === chief.id);
  // The Chief Coordinator's chat stays at the top.
  const threads = app.listThreads().filter((t) => {
    if (t.kind === 'dm' && !app.getAgent(t.agentIds[0])) return false;
    if (!q) return true;
    const title = threadTitle(app, t).toLowerCase();
    return title.includes(q) || (t.preview?.text || '').toLowerCase().includes(q);
  }).sort((a, b) => chiefChat(b) - chiefChat(a));
  const profileName = app.settings.profile?.name || '';

  return html`
    <div class="pane-list">
      <header class="topbar">
        <button class="initials" aria-label=${tr('Settings')} onClick=${() => ui.openSheet('settings')}>${profileName ? initials(profileName) : html`<${Icon.gear} size="20" />`}</button>
        <div class="spacer"></div>
        <${ComputerButton} onClick=${() => ui.openSheet('computer', {})} />
        <button class="circle-btn" aria-label=${tr('Search')} onClick=${() => {
          setSearching(!searching);
          setQuery('');
        }}><${Icon.search} /></button>
        <button ref=${plusRef} class="circle-btn" aria-label=${tr('New')} onClick=${() => setMenu(plusRef.current)}><${Icon.plus} /></button>
      </header>
      ${menu && html`<${Popover} anchor=${menu} onClose=${() => setMenu(null)} items=${[
        { label: tr('New Bot'), onClick: () => ui.openSheet('createBot') },
        { label: tr('New Group Chat'), onClick: () => ui.openSheet('newGroup') },
      ]} />`}
      <div class="home-scroll" onScroll=${() => swiped && setSwiped(null)}>
        ${searching && html`<div class="search-bar"><${Icon.search} />
          <input autofocus placeholder=${tr('Search bots and chats')} value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} />
          ${query && html`<button aria-label=${tr('Clear')} onClick=${() => setQuery('')}><${Icon.x} size="16" /></button>`}
        </div>`}
        <${ComputerNotice} />
        ${!threads.length && !q && html`<${EmptyHome} />`}
        ${!threads.length && q && html`<div class="empty-home"><p>${tr('No bots match “{query}”.', { query })}</p></div>`}
        ${threads.map((t) => html`<${ThreadRow} key=${t.id} thread=${t} active=${t.id === activeThreadId} swiped=${swiped} onSwipe=${setSwiped} />`)}
      </div>
    </div>`;
}

const DISMISSED = 'holly.dismissedNotices';

function dismissedNotices() {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED) || '[]');
  } catch {
    return [];
  }
}

/**
 * What to do about the account's computer when the bots can't run there
 * (noticeAbout in src/main.js), in a slim row at the top of the list rather
 * than over the app. Put away, it stays away until there's something else
 * to say.
 */
function ComputerNotice() {
  const app = useApp();
  useTopics(['computers']); // it changes while the app is open (watchComputers in src/main.js)
  const notice = app.computerNotice;
  const [closed, setClosed] = useState(null); // the notice put away here
  if (!notice || closed === notice || (notice.key && dismissedNotices().includes(notice.key))) return null;
  const dismiss = () => {
    setClosed(notice);
    if (!notice.key) return;
    try {
      localStorage.setItem(DISMISSED, JSON.stringify([...dismissedNotices().filter((key) => key !== notice.key), notice.key].slice(-10)));
    } catch { /* storage blocked: it's back next time the app opens */ }
  };
  return html`
    <div class="list-notice" role="status">
      <${Icon.monitor} size="18" />
      <span>${notice.text}</span>
      ${notice.action && html`<button class="list-notice-action" onClick=${notice.action.onClick}>${notice.action.label}</button>`}
      <button class="list-notice-close" aria-label=${tr('Dismiss')} onClick=${dismiss}><${Icon.x} size="16" /></button>
    </div>`;
}

export function threadTitle(app, t) {
  if (t.kind === 'dm') return app.getAgent(t.agentIds[0])?.name || t.title || tr('Bot');
  return t.title || t.agentIds.map((id) => app.getAgent(id)?.name).filter(Boolean).join(', ');
}

/** How far a row slides left to show its Delete button. */
const SWIPE_OPEN = 88;

/** A chat in the list. Swiping it left shows Delete (the bot, or a group
 * chat); one row is open at a time, and a tap or a scroll closes it. */
function ThreadRow({ thread, active, swiped, onSwipe }) {
  const app = useApp();
  const ui = useUi();
  const open = swiped === thread.id;
  const [drag, setDrag] = useState(null); // the row's offset while a finger moves it
  const gesture = useRef(null);
  const moved = useRef(false); // this touch was a swipe or closed another row, not a tap
  const busy = app.runtime.isThreadBusy(thread.id) || thread.status === 'working';
  const waiting = thread.status === 'waiting';
  const kind = thread.preview?.kind || 'normal';
  const previewClass = kind === 'waiting' ? 'waiting' : kind === 'error' ? 'error' : '';
  const agents = thread.agentIds.map((id) => app.getAgent(id)).filter(Boolean);
  const agent = agents[0];
  const isChief = thread.kind === 'dm' && agent?.role === 'chief';
  const title = threadTitle(app, thread);
  const at = thread.preview?.at || thread.updatedAt;
  let preview = phraseOr(thread.preview?.say, thread.preview?.text || '');
  if (thread.kind === 'group' && thread.preview?.authorId && thread.preview.authorId !== 'user' && kind === 'normal') {
    const who = app.getAgent(thread.preview.authorId)?.name;
    if (who) preview = `${who}: ${preview}`;
  }
  if (busy && !preview) preview = tr('Working…');

  // A sideways drag moves the row; an up-and-down one is left to the list's scrolling.
  const down = (e) => {
    moved.current = !!swiped && !open;
    if (moved.current) onSwipe(null);
    if (e.pointerType === 'mouse') return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: open ? -SWIPE_OPEN : 0, at: open ? -SWIPE_OPEN : 0, sideways: null };
  };
  const move = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.sideways === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.sideways = Math.abs(dx) > Math.abs(dy);
      if (g.sideways) e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (!g.sideways) return;
    g.at = Math.min(0, Math.max(-SWIPE_OPEN * 1.4, g.from + dx));
    setDrag(g.at);
  };
  const up = (e) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (!g.sideways) return;
    moved.current = true;
    setDrag(null);
    const opening = e.type === 'pointerup' && g.at < -SWIPE_OPEN / 2;
    if (opening && !open) haptic(app);
    onSwipe(opening ? thread.id : null);
  };
  const tap = () => {
    if (moved.current) return;
    if (swiped) return onSwipe(null);
    ui.navigate(`#/chat/${thread.id}`);
  };
  const remove = async () => {
    const dm = thread.kind === 'dm' && agent;
    const ok = await ui.confirm(dm
      ? { title: tr('Delete {name}?', { name: agent.name }), message: tr('This deletes the bot, its chats, memories, files and routines. This cannot be undone.'), confirmText: tr('Delete'), danger: true }
      : { title: tr('Delete {name}?', { name: title }), message: tr('Bots and their memories are not affected.'), confirmText: tr('Delete'), danger: true });
    onSwipe(null);
    if (!ok) return;
    if (active) ui.navigate('#/');
    if (dm) await app.deleteAgent(agent.id);
    else await app.deleteThread(thread.id);
  };
  const x = drag ?? (open ? -SWIPE_OPEN : 0);

  return html`
    <div class=${`swipe-row ${x ? 'shifted' : ''}`}>
      <button class="swipe-delete" tabindex=${open ? 0 : -1} aria-hidden=${!open} onClick=${remove}><${Icon.trash} size="20" />${tr('Delete')}</button>
      <button class=${`row-bot ${active ? 'active' : ''} ${drag !== null ? 'dragging' : ''}`} style=${x ? `transform:translateX(${x}px)` : ''}
        onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onClick=${tap}>
        ${thread.kind === 'group'
          ? html`<${AvatarStack} agents=${agents} size=${48} rest="lookUpRight" activityOf=${(a) => botActivity(app, a, thread.id)} />`
          : html`<${Avatar} shape=${agent?.shape} color=${agent?.color} size=${48} rest="lookUpRight" activity=${botActivity(app, agent, thread.id) || (busy ? 'thinking' : null)} anim=${thinkingOf(agent)} status=${busy ? 'working' : undefined} />`}
        <div class="meta">
          <div class=${`line1 ${isChief ? 'tagged' : ''}`}>
            <span class="title">${title}</span>
            ${isChief && html`<span class="chief-tag">${tr('Chief')}</span>`}
            ${!(thread.unread && !active) && html`<span class="time">${at ? shortTime(at) : ''}</span>`}
          </div>
          <div class="line2">
            <span class=${`preview ${waiting ? 'waiting' : previewClass}`}>${preview}</span>
            ${waiting && kind === 'waiting' ? html`<span class="dot waiting"></span>` : thread.unread && !active ? html`<span class="dot unread"></span>` : null}
          </div>
        </div>
      </button>
    </div>`;
}

function EmptyHome() {
  const app = useApp();
  const ui = useUi();
  return html`
    <div class="empty-home">
      <${Avatar} shape="cloud" color="blue" size=${96} live />
      <h2>${tr('Make your first bot')}</h2>
      <p>${tr('Each bot gets its own name, look, personality and long-term memory — and your bots can talk to each other.')}</p>
      <div class="btn-row" style="justify-content:center">
        <button class="btn primary" onClick=${() => ui.openSheet('createBot')}><${Icon.plus} size="18" /> ${tr('New Bot')}</button>
      </div>
      ${!app.remote && html`
        <button class="computer-cta" onClick=${() => ui.openSheet('settings', { page: 'computer' })}>
          <${Icon.monitor} size="22" />
          <span><b>${tr('Let your bots use your computer')}</b><br />${tr('Run Holly Computer on your PC or Mac: bots work there around the clock and you control them from your phone.')}</span>
          <${Icon.chevron} size="18" />
        </button>`}
    </div>`;
}
