import { html, useEffect, useRef, useState, useLayoutEffect } from '../../vendor/preact.js';
import { useApp, useUi, useTopics, useMessages } from './hooks.js';
import { Avatar, AvatarStack, botActivity, thinkingOf } from './avatar.js';
import { Icon } from './icons.js';
import { MessageView } from './message.js';
import { Composer } from './composer.js';
import { VoiceMode } from './voice.js';
import { formatDayTime } from '../core/util.js';
import { threadTitle } from './home.js';

const GAP = 60 * 60 * 1000;
/** How long a lost connection to the computer shows as connecting. The app
 * keeps trying after that, but the computer is off as far as anyone can tell. */
const RECONNECT_MS = 30_000;

/** The computer's connection: 'connected', 'connecting' (this app lost it a
 * moment ago and is getting it back), or 'off' (no computer, or gone a while). */
function computerStatus(app, now = Date.now()) {
  if (app.remote && app.reachable === false) return now - (app.unreachableSince || now) < RECONNECT_MS ? 'connecting' : 'off';
  return app.computer?.connected ? 'connected' : 'off';
}

const COMPUTER_LABEL = { connected: 'Computer, connected', connecting: 'Computer, connecting', off: 'Computer, not connected' };

/** The button at the top right of a chat: opens the bot's computer, and shows
 * the connection. Grayed out while there's none, the computer pulsing blue
 * while it connects, solid green while connected. */
function ComputerButton({ onClick }) {
  const app = useApp();
  useTopics(['computer', 'reachable']);
  const [, redraw] = useState(0);
  const status = computerStatus(app);
  // Connecting goes gray once it has taken a while: look again then.
  useEffect(() => {
    if (status !== 'connecting') return undefined;
    const t = setTimeout(() => redraw((n) => n + 1), Math.max(0, app.unreachableSince + RECONNECT_MS - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [status, app.unreachableSince]);
  return html`<button class=${`circle-btn computer-btn is-${status}`} aria-label=${COMPUTER_LABEL[status]} onClick=${onClick}><${Icon.monitor} /></button>`;
}

export function ChatScreen({ threadId, wide }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['threads', 'agents', 'runs', `thread:${threadId}`]);
  const thread = app.getThread(threadId);
  const messages = useMessages(threadId);
  const scrollRef = useRef(null);
  const stick = useRef(true);
  const [voice, setVoice] = useState(false);

  useEffect(() => {
    app.setViewing(threadId);
    const onVis = () => document.visibilityState === 'visible' && app.markRead(threadId);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (app.viewingThreadId === threadId) app.setViewing(null);
    };
  }, [threadId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    stick.current = true;
  }, [threadId]);

  if (!thread) {
    return html`<div class="pane-chat"><div class="chat-topbar"><button class="circle-btn" onClick=${() => ui.navigate('#/')}><${Icon.back} /></button></div>
      <div class="empty-home"><p>This chat no longer exists.</p></div></div>`;
  }

  const agents = thread.agentIds.map((id) => app.getAgent(id)).filter(Boolean);
  const agent = agents[0];
  // While a bot is busy, its face sits under the whole chat (below any message
  // sent meanwhile), thinking or working.
  const busy = app.runtime.isThreadBusy(threadId);
  const runAgent = busy ? app.getAgent(app.runtime.runs.get(threadId)?.agentId) : null;
  const title = threadTitle(app, thread);
  const isGroup = thread.kind === 'group';
  const isChannel = thread.kind === 'agents';
  // The bot in the header is never frozen: it idles (glances, bobs, blinks),
  // plays its thinking animation while its AI thinks or writes, and the
  // working one while it does a task, in this chat or anywhere else (a
  // routine, a job for another bot).
  const face = isChannel ? agents[1] : agent;
  const faceActivity = botActivity(app, face, threadId) || (busy && !isGroup ? 'thinking' : null);
  const activityOf = (a) => botActivity(app, a, threadId);

  const onScroll = (e) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const openProfile = () => {
    if (isGroup) ui.openSheet('groupInfo', { threadId });
    else if (isChannel) ui.openSheet('botProfile', { agentId: agents[1]?.id || agent?.id });
    else if (agent) ui.openSheet('botProfile', { agentId: agent.id });
  };

  const list = (messages || []).filter((m) => !m.hidden && !m.quiet);
  let lastShown = 0;
  let prevAuthor = null;
  const items = [];
  list.forEach((m, i) => {
    if (m.createdAt - lastShown > GAP) {
      items.push(html`<div class="day-sep" key=${`sep-${m.id}`}>${formatDayTime(m.createdAt)}</div>`);
      prevAuthor = null;
    }
    lastShown = m.createdAt;
    const showAuthor = (isGroup || isChannel) && m.authorType === 'agent' && m.authorId !== prevAuthor;
    prevAuthor = m.authorType === 'agent' ? m.authorId : null;
    items.push(html`<${MessageView} key=${m.id} msg=${m} thread=${thread} showAuthor=${showAuthor} isLast=${i === list.length - 1} />`);
  });

  return html`
    <div class="pane-chat">
      <header class="chat-topbar">
        ${wide ? html`<span></span>` : html`<button class="circle-btn" aria-label="Back" onClick=${() => ui.navigate('#/')}><${Icon.back} /></button>`}
        <button class="name-pill" onClick=${openProfile} aria-label=${`${title} settings`}>
          ${isGroup
            ? html`<${AvatarStack} agents=${agents} size=${30} activityOf=${activityOf} live />`
            : html`<${Avatar} shape=${face?.shape} color=${face?.color} size=${30} live activity=${faceActivity} anim=${thinkingOf(face)} />`}
          <span class="name">${title}</span>
          ${isGroup && html`<span class="sub">${agents.length}</span>`}
        </button>
        <${ComputerButton} onClick=${() => ui.openSheet('computer', { agentId: (isChannel ? agents[1] : agent)?.id, threadId })} />
      </header>
      <div class="chat-scroll" ref=${scrollRef} onScroll=${onScroll}>
        <div class="chat-inner">
          ${messages === null && html`<div class="notice">Loading…</div>`}
          ${isChannel && html`<div class="notice">Private channel between ${agents.map((a) => a.name).join(' and ')}. Bots use it when they message each other.</div>`}
          ${items}
          ${busy && runAgent && html`<div class="typing"><${Avatar} shape=${runAgent.shape} color=${runAgent.color} size=${34} activity=${botActivity(app, runAgent, threadId) || 'thinking'} anim=${thinkingOf(runAgent)} /></div>`}
        </div>
      </div>
      ${!isChannel && html`<${Composer} thread=${thread} agents=${agents} onVoice=${() => setVoice(true)} />`}
      ${isChannel && html`<div class="composer" style="justify-content:center;color:var(--muted);font-size:14px">Read-only · bots talk here on their own</div>`}
      ${voice && html`<${VoiceMode} thread=${thread} agent=${agent} onClose=${() => setVoice(false)} />`}
    </div>`;
}
