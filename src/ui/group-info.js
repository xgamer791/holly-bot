import { html } from '../../vendor/preact.js';
import { useApp, useUi, useTopics } from './hooks.js';
import { Avatar, AvatarStack } from './avatar.js';
import { Sheet, Group, Row, Segmented } from './components.js';
import { tr } from './i18n.js';

export function GroupInfoSheet({ threadId, onClose }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['threads', 'agents']);
  const t = app.getThread(threadId);
  if (!t) return html`<${Sheet} title=${tr('Group')} onClose=${onClose}><p>${tr('Group not found.')}</p><//>`;
  const members = t.agentIds.map((id) => app.getAgent(id)).filter(Boolean);
  const others = app.listAgents().filter((a) => !t.agentIds.includes(a.id));
  return html`
    <${Sheet} title=${t.title} onClose=${onClose}>
      <div class="create-preview" style="padding:10px 0 18px"><${AvatarStack} agents=${members} size=${110} /></div>
      <${Group}>
        <div class="row"><div class="label"><div class="t">${tr('Name')}</div></div><input type="text" value=${t.title} onChange=${(e) => app.updateThread(t.id, { title: e.currentTarget.value.trim() || t.title })} /></div>
        <div class="row" style="flex-direction:column;align-items:stretch;gap:10px"><div class="label"><div class="t">${tr('Who replies')}</div></div>
          <${Segmented} value=${t.mode || 'auto'} onChange=${(mode) => app.updateThread(t.id, { mode })} options=${[{ value: 'auto', label: tr('Smart') }, { value: 'all', label: tr('Everyone') }, { value: 'mention', label: tr('@Mentions') }]} /></div>
      <//>
      <${Group} label=${tr('Members')}>
        ${members.map((a) => html`<${Row} key=${a.id} icon=${html`<${Avatar} shape=${a.shape} color=${a.color} size=${32} />`} title=${a.name} sub=${a.description}
          value=${members.length > 2 ? tr('Remove') : ''} onClick=${members.length > 2 ? () => app.updateThread(t.id, { agentIds: t.agentIds.filter((id) => id !== a.id) }) : () => ui.openSheet('botProfile', { agentId: a.id })} />`)}
        ${others.map((a) => html`<${Row} key=${a.id} icon=${html`<${Avatar} shape=${a.shape} color=${a.color} size=${32} />`} title=${tr('Add {name}', { name: a.name })}
          onClick=${() => app.updateThread(t.id, { agentIds: [...t.agentIds, a.id] })} />`)}
      <//>
      <${Group}>
        <${Row} title=${tr('Clear chat')} onClick=${async () => (await ui.confirm({ title: tr('Clear this group chat?'), confirmText: tr('Clear'), danger: true })) && app.clearThread(t.id)} />
        <${Row} title=${tr('Delete group')} danger onClick=${async () => {
          if (await ui.confirm({ title: tr('Delete {name}?', { name: t.title }), message: tr('Bots and their memories are not affected.'), confirmText: tr('Delete'), danger: true })) {
            onClose();
            ui.navigate('#/');
            await app.deleteThread(t.id);
          }
        }} />
      <//>
    <//>`;
}
