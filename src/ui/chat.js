import { html, useEffect, useRef, useState, useLayoutEffect } from '../../vendor/preact.js';
import { useApp, useUi, useTopics, useMessages } from './hooks.js';
import { Avatar, AvatarStack, botActivity, thinkingOf } from './avatar.js';
import { Icon } from './icons.js';
import { MessageView } from './message.js';
import { Composer } from './composer.js';
import { VoiceMode } from './voice.js';
import { ComputerButton } from './computer-button.js';
import { threadTitle } from './home.js';
import { dayTime, listText, tr } from './i18n.js';

const GAP = 60 * 60 * 1000;

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
      <div class="empty-home"><p>${tr('This chat no longer exists.')}</p></div></div>`;
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
  // The bot in the header idles (glances, bobs gently, blinks) the whole
  // time; while it's busy, its face under the chat plays the thinking and
  // working animations, so the two don't do the same thing.
  const face = isChannel ? agents[1] : agent;

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
      items.push(html`<div class="day-sep" key=${`sep-${m.id}`}>${dayTime(m.createdAt)}</div>`);
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
        ${wide ? html`<span></span>` : html`<button class="circle-btn" aria-label=${tr('Back')} onClick=${() => ui.navigate('#/')}><${Icon.back} /></button>`}
        <button class="name-pill" onClick=${openProfile} aria-label=${tr('{name} settings', { name: title })}>
          ${isGroup
            ? html`<${AvatarStack} agents=${agents} size=${30} live />`
            : html`<${Avatar} shape=${face?.shape} color=${face?.color} size=${30} live />`}
          <span class="name">${title}</span>
          ${isGroup && html`<span class="sub">${agents.length}</span>`}
        </button>
        <${ComputerButton} onClick=${() => ui.openSheet('computer', { agentId: (isChannel ? agents[1] : agent)?.id, threadId })} />
      </header>
      <div class="chat-scroll" ref=${scrollRef} onScroll=${onScroll}>
        <div class="chat-inner">
          ${messages === null && html`<div class="notice">${tr('Loading…')}</div>`}
          ${isChannel && html`<div class="notice">${tr('Private channel between {names}. Bots use it when they message each other.', { names: listText(agents.map((a) => a.name)) })}</div>`}
          ${items}
          ${busy && runAgent && html`<div class="typing"><${Avatar} shape=${runAgent.shape} color=${runAgent.color} size=${36} activity=${botActivity(app, runAgent, threadId) || 'thinking'} anim=${thinkingOf(runAgent)} /></div>`}
        </div>
      </div>
      ${!isChannel && html`<${Composer} thread=${thread} agents=${agents} onVoice=${() => setVoice(true)} />`}
      ${isChannel && html`<div class="composer" style="justify-content:center;color:var(--muted);font-size:14px">${tr('Read-only · bots talk here on their own')}</div>`}
      ${voice && html`<${VoiceMode} thread=${thread} agent=${agent} onClose=${() => setVoice(false)} />`}
    </div>`;
}
