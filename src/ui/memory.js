import { html, useState } from '../../vendor/preact.js';
import { useApp, useUi, useAsync, useTopics } from './hooks.js';
import { Sheet, Tabs, Field, Group, Row, downloadBlob } from './components.js';
import { Icon } from './icons.js';
import { account } from '../account/account.js';
import { SHARED_ID, USER_ID, MEMORY_TYPES } from '../core/memory/store.js';
import { jaccard } from '../core/memory/text.js';
import { callName, truncate } from '../core/util.js';
import { dateText, mark, tr, trn } from './i18n.js';

/** What the app calls each type of memory (MEMORY_TYPES; the types stay English). */
const TYPE_NAMES = {
  fact: mark('fact'),
  preference: mark('preference'),
  person: mark('person'),
  project: mark('project'),
  event: mark('event'),
  goal: mark('goal'),
  instruction: mark('instruction'),
  reflection: mark('reflection'),
  note: mark('note'),
};

/** A memory type's name in the app's language (one it doesn't know, as it is). */
const typeName = (type) => (TYPE_NAMES[type] ? tr(TYPE_NAMES[type]) : type);

export function MemorySheet({ agentId, onClose, tab: initialTab }) {
  const app = useApp();
  useTopics(['agents']);
  const agent = app.getAgent(agentId);
  const [tab, setTab] = useState(initialTab || 'memories');
  if (!agent) return html`<${Sheet} title=${tr('Memory')} onClose=${onClose}><p>${tr('Bot not found.')}</p><//>`;
  return html`
    <${Sheet} title=${tr("{name}'s memory", { name: agent.name })} onClose=${onClose}>
      <${Tabs} value=${tab} onChange=${setTab} tabs=${[{ value: 'memories', label: tr('Memories') }, { value: 'core', label: tr('Core') }, { value: 'team', label: tr('Team memory') }]} />
      ${tab === 'memories' && html`<${MemoryList} ownerId=${agent.id} agent=${agent} />`}
      ${tab === 'core' && html`<${CoreMemory} agent=${agent} />`}
      ${tab === 'team' && html`
        <p class="hint" style="font-size:14px;margin:4px 4px 10px">${tr('Shared notes every bot can read (and write with remember → shared). Good for team rules, project facts and handoffs.')}</p>
        <${MemoryList} ownerId=${SHARED_ID} agent=${agent} shared />`}
    <//>`;
}

/**
 * About you: what the bots know about the user (src/core/memory/store.js
 * USER_ID), learned from their chats, and their email when they allow it.
 * Every bot sees it and uses it, only to help them. Here they see it, fix or
 * delete it, and turn the learning on or off (Settings → Memory & Context).
 */
export function AboutYouSheet({ onClose }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['settings']);
  const mem = app.settings.memory || {};
  const set = (patch) => app.saveSettings({ memory: { ...mem, ...patch } });
  const learn = mem.learnUser !== false;
  const conns = useAsync(() => (account.signedIn ? account.authed('query', 'connectors:list') : Promise.resolve([])), [account.signedIn]);
  const email = (conns.data || []).some((c) => c.service === 'gmail' || c.service === 'outlook');
  const [busy, setBusy] = useState(false);
  // Their name, and what the bots call them (src/core/prompts.js About the user).
  const profile = app.settings.profile || {};
  const saveProfile = (patch) => app.saveSettings({ profile: { ...profile, ...patch } });
  const editName = async () => {
    const value = await ui.confirm({ title: tr('Your name'), input: { value: profile.name || '', placeholder: tr('Your name') }, confirmText: tr('Save') });
    if (typeof value === 'string') saveProfile({ name: value.trim() });
  };
  const editCall = async () => {
    const value = await ui.confirm({
      title: tr('What should your bots call you?'),
      message: tr("Leave it empty and they won't call you by name."),
      input: { value: profile.noName ? '' : callName(profile), placeholder: tr('A name or nickname') },
      confirmText: tr('Save'),
    });
    if (typeof value === 'string') saveProfile({ callMe: value.trim(), noName: !value.trim() });
  };
  const learnNow = async () => {
    setBusy(true);
    try {
      const n = await app.learnFromEmail();
      ui.toast(n ? trn(n, 'Learned {n} new thing about you', 'Learned {n} new things about you') : tr('Nothing new about you in your recent email'));
    } catch (err) {
      ui.toast(err.message, { error: true });
    } finally {
      setBusy(false);
    }
  };
  return html`
    <${Sheet} title=${tr('About you')} onClose=${onClose}>
      <p class="hint" style="font-size:14px;margin:4px 4px 10px">${tr("What your bots know about you: your name, how to reach you, what you like and what you don't. Every bot uses it, only to help you. Change or delete anything here.")}</p>
      <${Group}>
        <${Row} title=${tr('Your name')} value=${profile.name || tr('Not known yet')} onClick=${editName} />
        <${Row} title=${tr('What your bots call you')} value=${profile.noName ? tr('Not by name') : callName(profile) || '—'} onClick=${editCall} />
      <//>
      <${Group}>
        <${Row} title=${tr('Learn about me')} sub=${tr('Bots remember what you tell them about yourself')} toggle=${learn} onToggle=${(v) => set({ learnUser: v })} />
        ${learn && html`<${Row} title=${tr('Learn from my email')} sub=${email ? tr('Also from the emails they read for you, like orders and bookings') : tr('Connect Gmail or Outlook in Settings → Plugins first')}
          toggle=${!!mem.fromEmail} onToggle=${(v) => set({ fromEmail: v })} />`}
      <//>
      ${learn && mem.fromEmail && email && html`<button class="btn block" style="margin:-8px 0 16px" disabled=${busy} onClick=${learnNow}>
        ${busy ? html`<span class="spinner"></span>` : html`<${Icon.mail} size="18" />`} ${tr('Learn from my recent email')}</button>`}
      <${MemoryList} ownerId=${USER_ID} kind="user" />
    <//>`;
}

/** `kind`: whose memories: a bot's ('bot'), the team's, or what the bots know about the user ('user'). */
function MemoryList({ ownerId, agent, shared = false, kind = shared ? 'team' : 'bot' }) {
  const app = useApp();
  const ui = useUi();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState('');
  const { data: all = [] } = useAsync(() => app.memory.list(ownerId), [ownerId], [`memory:${ownerId}`]);
  const { data: hits } = useAsync(async () => (query.trim() ? (await app.memory.search(ownerId, query, { limit: 50, touch: false, minScore: 0.05 })).map((r) => r.memory) : null), [ownerId, query], [`memory:${ownerId}`]);
  let list = hits || [...all].sort((a, b) => (b.pinned - a.pinned) || b.updatedAt - a.updatedAt);
  if (type) list = list.filter((m) => m.type === type);
  const types = [...new Set(all.map((m) => m.type))];

  const tidy = async () => {
    setBusy('tidy');
    let merged = 0;
    const rows = [...all].sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
    const removed = new Set();
    for (let i = 0; i < rows.length; i++) {
      if (removed.has(rows[i].id)) continue;
      for (let j = i + 1; j < rows.length; j++) {
        if (removed.has(rows[j].id) || rows[j].pinned) continue;
        if (jaccard(rows[i].text, rows[j].text) >= 0.72) {
          await app.memory.remove(rows[j].id);
          removed.add(rows[j].id);
          merged++;
        }
      }
    }
    setBusy('');
    ui.toast(merged ? trn(merged, 'Merged {n} duplicate memory', 'Merged {n} duplicate memories') : tr('No duplicates found'));
  };

  const reflectNow = async () => {
    setBusy('reflect');
    try {
      const n = await app.reflectNow(agent.id);
      ui.toast(trn(n, 'Reflected: {n} new insight; profile refreshed.', 'Reflected: {n} new insights; profile refreshed.'));
    } catch (err) {
      ui.toast(err.message, { error: true });
    } finally {
      setBusy('');
    }
  };

  const exportMd = () => {
    const title = kind === 'user' ? 'About you' : `${kind === 'team' ? 'Team' : agent.name} memory`;
    const md = `# ${title}\n\n${all.map((m) => `- (${m.type}, ${new Date(m.createdAt).toISOString().slice(0, 10)}${m.pinned ? ', pinned' : ''}) ${m.text}`).join('\n')}\n`;
    const file = kind === 'user' ? 'about-you' : `${kind === 'team' ? 'team' : agent.name.toLowerCase().replace(/\W+/g, '-')}-memory`;
    downloadBlob(new Blob([md], { type: 'text/markdown' }), `${file}.md`);
  };

  return html`
    <div class="search-bar" style="margin:6px 0 10px"><${Icon.search} />
      <input placeholder=${tr('Search memories')} value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} />
    </div>
    ${types.length > 1 && html`<div class="chips" style="margin-bottom:8px">
      <button class=${`chip ${!type ? 'on' : ''}`} onClick=${() => setType('')}>${tr('All {count}', { count: all.length })}</button>
      ${types.map((t) => html`<button key=${t} class=${`chip ${type === t ? 'on' : ''}`} onClick=${() => setType(type === t ? '' : t)}>${typeName(t)}</button>`)}
    </div>`}
    <div class="btn-row" style="margin:6px 0 4px">
      <button class="btn small" onClick=${() => setAdding(!adding)}><${Icon.plus} size="16" /> ${tr('Add')}</button>
      ${kind === 'bot' && html`<button class="btn small" disabled=${!!busy} onClick=${reflectNow}>${busy === 'reflect' ? html`<span class="spinner"></span>` : html`<${Icon.sparkle} size="16" />`} ${tr('Reflect')}</button>`}
      <button class="btn small" disabled=${!!busy} onClick=${tidy}>${busy === 'tidy' ? html`<span class="spinner"></span>` : null} ${tr('Tidy up')}</button>
      <button class="btn small" onClick=${exportMd}><${Icon.download} size="16" /> ${tr('Export')}</button>
    </div>
    ${adding && html`<${MemoryEditor} onCancel=${() => setAdding(false)} onSave=${async (m) => {
      await app.memory.add(ownerId, { ...m, source: { kind: 'user' } });
      setAdding(false);
    }} />`}
    ${!list.length && html`<div class="empty-home" style="padding:40px 10px"><p>${query ? tr('No matching memories.')
      : kind === 'user' ? tr("Your bots haven't learned anything about you yet. As you chat, they remember what you tell them about yourself.")
      : kind === 'team' ? tr('No team memories yet.')
      : tr("{name} hasn't saved any memories yet. Chat for a while — important facts are saved automatically.", { name: agent.name })}</p></div>`}
    ${list.map((m) => (editing === m.id
      ? html`<${MemoryEditor} key=${m.id} initial=${m} onCancel=${() => setEditing(null)} onSave=${async (patch) => {
        await app.memory.update(m.id, patch);
        setEditing(null);
      }} />`
      : html`<div class="mem" key=${m.id}>
          <div class="txt">${m.text}</div>
          <div class="meta">
            <span class="badge">${typeName(m.type)}</span>
            <span class="imp" title=${tr('Importance {importance}/10', { importance: m.importance })}>${'●'.repeat(Math.ceil((m.importance || 5) / 2))}</span>
            <span>${dateText(m.createdAt, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            ${m.source?.kind === 'auto' && html`<span>${tr('auto')}</span>`}
            ${m.source?.kind === 'email' && html`<span>${tr('from email')}</span>`}
            <span class="acts">
              <button class=${m.pinned ? 'on' : ''} aria-label=${m.pinned ? tr('Unpin') : tr('Pin')} onClick=${() => app.memory.update(m.id, { pinned: !m.pinned })}><${Icon.pin} /></button>
              <button aria-label=${tr('Edit')} onClick=${() => setEditing(m.id)}><${Icon.edit} /></button>
              <button aria-label=${tr('Delete')} onClick=${async () => {
                if (await ui.confirm({ title: tr('Forget this?'), message: truncate(m.text, 160), confirmText: tr('Forget'), danger: true })) await app.memory.remove(m.id);
              }}><${Icon.trash} /></button>
            </span>
          </div>
        </div>`))}`;
}

function MemoryEditor({ initial, onSave, onCancel }) {
  const [text, setText] = useState(initial?.text || '');
  const [type, setType] = useState(initial?.type || 'fact');
  const [importance, setImportance] = useState(initial?.importance || 6);
  return html`<div class="mem">
    <textarea class="textarea" style="min-height:80px" placeholder=${tr('e.g. Prefers morning meetings before 10am.')} value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>
    <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
      <select class="select" style="width:auto;padding:8px 10px" value=${type} onChange=${(e) => setType(e.currentTarget.value)}>
        ${MEMORY_TYPES.map((t) => html`<option value=${t}>${typeName(t)}</option>`)}
      </select>
      <label class="hint">${tr('Importance')} <input type="range" min="1" max="10" value=${importance} onInput=${(e) => setImportance(+e.currentTarget.value)} /> ${importance}</label>
      <span style="flex:1"></span>
      <button class="btn small" onClick=${onCancel}>${tr('Cancel')}</button>
      <button class="btn small primary" disabled=${!text.trim()} onClick=${() => onSave({ text: text.trim(), type, importance })}>${tr('Save')}</button>
    </div>
  </div>`;
}

function CoreMemory({ agent }) {
  const app = useApp();
  const ui = useUi();
  const core = { persona: '', human: '', notes: '', ...(agent.core || {}) };
  const save = async (key, value) => {
    await app.updateAgent(agent.id, { core: { ...core, [key]: value } });
    ui.toast(tr('Saved'));
  };
  const fields = [
    ['persona', tr('Persona'), tr('Who {name} is and how it sees its role. The bot updates this as it learns.', { name: agent.name })],
    ['human', tr('About you'), tr("{name}'s own notes about you, always in view. What all your bots know about you is in Settings → Memory & Context → About you.", { name: agent.name })],
    ['notes', tr('Notes'), tr('Current goals, ongoing tasks and reminders the bot keeps for itself.')],
  ];
  return html`
    <p class="hint" style="font-size:14px;margin:4px 4px 6px">${tr("Core memory is always in {name}'s context (unlike long-term memories, which are recalled when relevant).", { name: agent.name })}</p>
    ${fields.map(([k, label, hint]) => html`<${Field} key=${k} label=${label} hint=${hint}>
      <textarea class="textarea" value=${core[k]} onChange=${(e) => save(k, e.currentTarget.value)}></textarea>
    <//>`)}`;
}
