import { html, useState, useRef } from '../../vendor/preact.js';
import { useApp, useUi, useTopics } from './hooks.js';
import { Avatar, AvatarStack, botActivity, thinkingOf } from './avatar.js';
import { Icon } from './icons.js';
import { Popover } from './components.js';
import { initials, formatShort } from '../core/util.js';

export function HomeScreen({ activeThreadId }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['threads', 'agents', 'runs', 'settings']);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(null);
  const plusRef = useRef(null);

  const q = query.trim().toLowerCase();
  const threads = app.listThreads().filter((t) => {
    if (t.kind === 'dm' && !app.getAgent(t.agentIds[0])) return false;
    if (!q) return true;
    const title = threadTitle(app, t).toLowerCase();
    return title.includes(q) || (t.preview?.text || '').toLowerCase().includes(q);
  });
  const profileName = app.settings.profile?.name || '';

  return html`
    <div class="pane-list">
      <header class="topbar">
        <button class="initials" aria-label="Settings" onClick=${() => ui.openSheet('settings')}>${profileName ? initials(profileName) : html`<${Icon.gear} size="20" />`}</button>
        <div class="spacer"></div>
        <button class="circle-btn" aria-label="Search" onClick=${() => {
          setSearching(!searching);
          setQuery('');
        }}><${Icon.search} /></button>
        <button ref=${plusRef} class="circle-btn" aria-label="New" onClick=${() => setMenu(plusRef.current)}><${Icon.plus} /></button>
      </header>
      ${menu && html`<${Popover} anchor=${menu} onClose=${() => setMenu(null)} items=${[
        { label: 'New Bot', onClick: () => ui.openSheet('createBot') },
        { label: 'New Group Chat', onClick: () => ui.openSheet('newGroup') },
      ]} />`}
      <div class="home-scroll">
        ${searching && html`<div class="search-bar"><${Icon.search} />
          <input autofocus placeholder="Search bots and chats" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} />
          ${query && html`<button aria-label="Clear" onClick=${() => setQuery('')}><${Icon.x} size="16" /></button>`}
        </div>`}
        ${!threads.length && !q && html`<${EmptyHome} />`}
        ${!threads.length && q && html`<div class="empty-home"><p>No bots match “${query}”.</p></div>`}
        ${threads.map((t) => html`<${ThreadRow} key=${t.id} thread=${t} active=${t.id === activeThreadId} />`)}
      </div>
    </div>`;
}

export function threadTitle(app, t) {
  if (t.kind === 'dm') return app.getAgent(t.agentIds[0])?.name || t.title || 'Bot';
  return t.title || t.agentIds.map((id) => app.getAgent(id)?.name).filter(Boolean).join(', ');
}

function ThreadRow({ thread, active }) {
  const app = useApp();
  const ui = useUi();
  const busy = app.runtime.isThreadBusy(thread.id) || thread.status === 'working';
  const waiting = thread.status === 'waiting';
  const kind = thread.preview?.kind || 'normal';
  const previewClass = kind === 'waiting' ? 'waiting' : kind === 'error' ? 'error' : '';
  const agents = thread.agentIds.map((id) => app.getAgent(id)).filter(Boolean);
  const agent = agents[0];
  const title = threadTitle(app, thread);
  const at = thread.preview?.at || thread.updatedAt;
  let preview = thread.preview?.text || '';
  if (thread.kind === 'group' && thread.preview?.authorId && thread.preview.authorId !== 'user' && kind === 'normal') {
    const who = app.getAgent(thread.preview.authorId)?.name;
    if (who) preview = `${who}: ${preview}`;
  }
  if (busy && !preview) preview = 'Working…';
  return html`
    <button class=${`row-bot ${active ? 'active' : ''}`} onClick=${() => ui.navigate(`#/chat/${thread.id}`)}>
      ${thread.kind === 'group'
        ? html`<${AvatarStack} agents=${agents} size=${48} rest="lookUpRight" activityOf=${(a) => botActivity(app, a, thread.id)} />`
        : html`<${Avatar} shape=${agent?.shape} color=${agent?.color} size=${48} rest="lookUpRight" activity=${botActivity(app, agent, thread.id) || (busy ? 'thinking' : null)} anim=${thinkingOf(agent)} status=${busy ? 'working' : undefined} />`}
      <div class="meta">
        <div class="line1">
          <span class="title">${title}</span>
          ${!(thread.unread && !active) && html`<span class="time">${at ? formatShort(at) : ''}</span>`}
        </div>
        <div class="line2">
          <span class=${`preview ${waiting ? 'waiting' : previewClass}`}>${preview}</span>
          ${waiting && kind === 'waiting' ? html`<span class="dot waiting"></span>` : thread.unread && !active ? html`<span class="dot unread"></span>` : null}
        </div>
      </div>
    </button>`;
}

function EmptyHome() {
  const app = useApp();
  const ui = useUi();
  const hasKey = app.providers.readyProviders().length > 0;
  return html`
    <div class="empty-home">
      <${Avatar} shape="cloud" color="white" size=${96} live />
      <h2>Make your first bot</h2>
      <p>Each bot gets its own name, look, personality and long-term memory — and your bots can talk to each other.</p>
      ${!hasKey && html`<p>Bring your own key. DeepSeek is the default brain (smart and cheap); Claude, OpenAI, Grok, Gemini, OpenRouter and others work too. Your key stays ${app.remote ? 'on your computer' : app.db?.cloud ? 'in your account' : 'in this browser'}.</p>`}
      <div class="btn-row" style="justify-content:center">
        ${!hasKey && html`<button class="btn" onClick=${() => ui.openSheet('settings', { page: 'keys' })}><${Icon.key} size="18" /> Add API key</button>`}
        <button class="btn primary" onClick=${() => ui.openSheet('createBot')}><${Icon.plus} size="18" /> New Bot</button>
      </div>
      ${!app.remote && html`
        <button class="computer-cta" onClick=${() => ui.openSheet('settings', { page: 'computer' })}>
          <${Icon.monitor} size="22" />
          <span><b>Let your bots use your computer</b><br />Run Holly Computer on your PC or Mac: bots work there around the clock and you control them from your phone.</span>
          <${Icon.chevron} size="18" />
        </button>`}
    </div>`;
}
