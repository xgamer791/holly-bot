import { html } from '../../vendor/preact.js';
import { useApp, useUi, useTopics } from './hooks.js';
import { Avatar, AvatarStack, botActivity, thinkingOf } from './avatar.js';
import { Icon } from './icons.js';
import { Sheet, Group, Row, Segmented } from './components.js';
import { formatShort, truncate } from '../core/util.js';

/** Right-edge drawer: what every bot is doing right now, what's waiting on you, and bot-to-bot traffic. */
export function ActivityDrawer({ onClose }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['threads', 'runs', 'tasks', 'activity', 'agents']);
  const runs = app.runtime.activeRuns();
  const waiting = app.listThreads({ includeAgentChannels: true }).filter((t) => t.status === 'waiting');
  const channels = app.listThreads({ includeAgentChannels: true }).filter((t) => t.kind === 'agents').slice(0, 12);
  const tasks = [...app.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  const go = (href) => {
    onClose();
    ui.navigate(href);
  };
  return html`
    <div class="drawer-scrim" onClick=${onClose}></div>
    <aside class="drawer" aria-label="Activity">
      <header class="sheet-head"><h2>Activity</h2><button class="circle-btn" aria-label="Close" onClick=${onClose}><${Icon.x} /></button></header>
      <div class="sheet-body">
        <div class="group-label" style="margin-top:0">Working now</div>
        <div class="group">
          ${!runs.length && html`<div class="row"><div class="label"><div class="s">All bots are idle.</div></div></div>`}
          ${runs.map((r) => {
            const a = app.getAgent(r.agentId);
            const t = app.getThread(r.threadId);
            return html`<div class="row" key=${r.threadId}>
              <${Avatar} shape=${a?.shape} color=${a?.color} size=${32} activity=${r.phase === 'working' ? 'working' : 'thinking'} anim=${thinkingOf(a)} />
              <button class="label" style="text-align:left" onClick=${() => go(`#/chat/${r.threadId}`)}><div class="t">${a?.name}</div><div class="s">${t?.kind === 'agents' ? 'Talking with another bot' : t?.kind === 'group' ? `In ${t.title}` : 'Working on your request'}</div></button>
              <button class="stop-btn" aria-label="Stop" onClick=${() => Promise.resolve(app.runtime.stop(r.threadId)).catch((err) => ui.toast(err.message, { error: true }))}><span></span></button>
            </div>`;
          })}
        </div>
        ${waiting.length > 0 && html`<div class="group-label">Waiting for you</div><div class="group">
          ${waiting.map((t) => {
            const a = app.getAgent(t.preview?.authorId) || app.getAgent(t.agentIds[0]);
            return html`<${Row} key=${t.id} icon=${html`<${Avatar} shape=${a?.shape} color=${a?.color} size=${32} activity=${botActivity(app, a)} anim=${thinkingOf(a)} />`} title=${a?.name || t.title} sub=${t.preview?.text} onClick=${() => go(`#/chat/${t.id}`)} />`;
          })}</div>`}
        ${tasks.length > 0 && html`<div class="group-label">Delegated tasks</div><div class="group">
          ${tasks.map((k) => {
            const from = app.getAgent(k.fromAgentId);
            const to = app.getAgent(k.toAgentId);
            return html`<${Row} key=${k.id} title=${`${from?.name || '?'} → ${to?.name || '?'}`} sub=${truncate(k.task, 90)} value=${{ running: 'Working', done: 'Done', stopped: 'Stopped' }[k.status] || 'Failed'}
              onClick=${() => go(`#/chat/${k.replyThreadId}`)} />`;
          })}</div>`}
        <div class="group-label">Bot-to-bot conversations</div>
        <div class="group">
          ${!channels.length && html`<div class="row"><div class="label"><div class="s">When bots message each other, their conversations appear here.</div></div></div>`}
          ${channels.map((t) => html`<${Row} key=${t.id} icon=${html`<${AvatarStack} agents=${t.agentIds.map((id) => app.getAgent(id)).filter(Boolean)} size=${34} />`}
            title=${t.agentIds.map((id) => app.getAgent(id)?.name).join(' ↔ ')} sub=${t.preview?.text || ''} value=${t.preview?.at ? formatShort(t.preview.at) : ''} onClick=${() => go(`#/chat/${t.id}`)} />`)}
        </div>
      </div>
    </aside>`;
}

export function GroupInfoSheet({ threadId, onClose }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['threads', 'agents']);
  const t = app.getThread(threadId);
  if (!t) return html`<${Sheet} title="Group" onClose=${onClose}><p>Group not found.</p><//>`;
  const members = t.agentIds.map((id) => app.getAgent(id)).filter(Boolean);
  const others = app.listAgents().filter((a) => !t.agentIds.includes(a.id));
  return html`
    <${Sheet} title=${t.title} onClose=${onClose}>
      <div class="create-preview" style="padding:10px 0 18px"><${AvatarStack} agents=${members} size=${110} /></div>
      <${Group}>
        <div class="row"><div class="label"><div class="t">Name</div></div><input type="text" value=${t.title} onChange=${(e) => app.updateThread(t.id, { title: e.currentTarget.value.trim() || t.title })} /></div>
        <div class="row" style="flex-direction:column;align-items:stretch;gap:10px"><div class="label"><div class="t">Who replies</div></div>
          <${Segmented} value=${t.mode || 'auto'} onChange=${(mode) => app.updateThread(t.id, { mode })} options=${[{ value: 'auto', label: 'Smart' }, { value: 'all', label: 'Everyone' }, { value: 'mention', label: '@Mentions' }]} /></div>
      <//>
      <${Group} label="Members">
        ${members.map((a) => html`<${Row} key=${a.id} icon=${html`<${Avatar} shape=${a.shape} color=${a.color} size=${32} />`} title=${a.name} sub=${a.description}
          value=${members.length > 2 ? 'Remove' : ''} onClick=${members.length > 2 ? () => app.updateThread(t.id, { agentIds: t.agentIds.filter((id) => id !== a.id) }) : () => ui.openSheet('botProfile', { agentId: a.id })} />`)}
        ${others.map((a) => html`<${Row} key=${a.id} icon=${html`<${Avatar} shape=${a.shape} color=${a.color} size=${32} />`} title=${`Add ${a.name}`}
          onClick=${() => app.updateThread(t.id, { agentIds: [...t.agentIds, a.id] })} />`)}
      <//>
      <${Group}>
        <${Row} title="Clear chat" onClick=${async () => (await ui.confirm({ title: 'Clear this group chat?', confirmText: 'Clear', danger: true })) && app.clearThread(t.id)} />
        <${Row} title="Delete group" danger onClick=${async () => {
          if (await ui.confirm({ title: `Delete ${t.title}?`, message: 'Bots and their memories are not affected.', confirmText: 'Delete', danger: true })) {
            onClose();
            ui.navigate('#/');
            await app.deleteThread(t.id);
          }
        }} />
      <//>
    <//>`;
}
