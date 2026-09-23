import { html, useState } from '../../vendor/preact.js';
import { useApp, useUi, useAsync, useTopics } from './hooks.js';
import { Sheet, Tabs, Field, downloadBlob } from './components.js';
import { Icon } from './icons.js';
import { SHARED_ID, MEMORY_TYPES } from '../core/memory/store.js';
import { jaccard } from '../core/memory/text.js';
import { truncate } from '../core/util.js';

export function MemorySheet({ agentId, onClose, tab: initialTab }) {
  const app = useApp();
  useTopics(['agents']);
  const agent = app.getAgent(agentId);
  const [tab, setTab] = useState(initialTab || 'memories');
  if (!agent) return html`<${Sheet} title="Memory" onClose=${onClose}><p>Bot not found.</p><//>`;
  return html`
    <${Sheet} title=${`${agent.name}'s memory`} onClose=${onClose}>
      <${Tabs} value=${tab} onChange=${setTab} tabs=${[{ value: 'memories', label: 'Memories' }, { value: 'core', label: 'Core' }, { value: 'team', label: 'Team memory' }]} />
      ${tab === 'memories' && html`<${MemoryList} ownerId=${agent.id} agent=${agent} />`}
      ${tab === 'core' && html`<${CoreMemory} agent=${agent} />`}
      ${tab === 'team' && html`
        <p class="hint" style="font-size:14px;margin:4px 4px 10px">Shared notes every bot can read (and write with remember → shared). Good for team rules, project facts and handoffs.</p>
        <${MemoryList} ownerId=${SHARED_ID} agent=${agent} shared />`}
    <//>`;
}

function MemoryList({ ownerId, agent, shared = false }) {
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
    ui.toast(merged ? `Merged ${merged} duplicate ${merged === 1 ? 'memory' : 'memories'}` : 'No duplicates found');
  };

  const reflectNow = async () => {
    setBusy('reflect');
    try {
      const n = await app.reflectNow(agent.id);
      ui.toast(`Reflected: ${n} new insight${n === 1 ? '' : 's'}; profile refreshed.`);
    } catch (err) {
      ui.toast(err.message, { error: true });
    } finally {
      setBusy('');
    }
  };

  const exportMd = () => {
    const md = `# ${shared ? 'Team' : agent.name} memory\n\n${all.map((m) => `- (${m.type}, ${new Date(m.createdAt).toISOString().slice(0, 10)}${m.pinned ? ', pinned' : ''}) ${m.text}`).join('\n')}\n`;
    downloadBlob(new Blob([md], { type: 'text/markdown' }), `${shared ? 'team' : agent.name.toLowerCase().replace(/\W+/g, '-')}-memory.md`);
  };

  return html`
    <div class="search-bar" style="margin:6px 0 10px"><${Icon.search} />
      <input placeholder="Search memories" value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} />
    </div>
    ${types.length > 1 && html`<div class="chips" style="margin-bottom:8px">
      <button class=${`chip ${!type ? 'on' : ''}`} onClick=${() => setType('')}>All ${all.length}</button>
      ${types.map((t) => html`<button key=${t} class=${`chip ${type === t ? 'on' : ''}`} onClick=${() => setType(type === t ? '' : t)}>${t}</button>`)}
    </div>`}
    <div class="btn-row" style="margin:6px 0 4px">
      <button class="btn small" onClick=${() => setAdding(!adding)}><${Icon.plus} size="16" /> Add</button>
      ${!shared && html`<button class="btn small" disabled=${!!busy} onClick=${reflectNow}>${busy === 'reflect' ? html`<span class="spinner"></span>` : html`<${Icon.sparkle} size="16" />`} Reflect</button>`}
      <button class="btn small" disabled=${!!busy} onClick=${tidy}>${busy === 'tidy' ? html`<span class="spinner"></span>` : null} Tidy up</button>
      <button class="btn small" onClick=${exportMd}><${Icon.download} size="16" /> Export</button>
    </div>
    ${adding && html`<${MemoryEditor} onCancel=${() => setAdding(false)} onSave=${async (m) => {
      await app.memory.add(ownerId, { ...m, source: { kind: 'user' } });
      setAdding(false);
    }} />`}
    ${!list.length && html`<div class="empty-home" style="padding:40px 10px"><p>${query ? 'No matching memories.' : shared ? 'No team memories yet.' : `${agent.name} hasn't saved any memories yet. Chat for a while — important facts are saved automatically.`}</p></div>`}
    ${list.map((m) => (editing === m.id
      ? html`<${MemoryEditor} key=${m.id} initial=${m} onCancel=${() => setEditing(null)} onSave=${async (patch) => {
        await app.memory.update(m.id, patch);
        setEditing(null);
      }} />`
      : html`<div class="mem" key=${m.id}>
          <div class="txt">${m.text}</div>
          <div class="meta">
            <span class="badge">${m.type}</span>
            <span class="imp" title=${`Importance ${m.importance}/10`}>${'●'.repeat(Math.ceil((m.importance || 5) / 2))}</span>
            <span>${new Date(m.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            ${m.source?.kind === 'auto' && html`<span>auto</span>`}
            <span class="acts">
              <button class=${m.pinned ? 'on' : ''} aria-label=${m.pinned ? 'Unpin' : 'Pin'} onClick=${() => app.memory.update(m.id, { pinned: !m.pinned })}><${Icon.pin} /></button>
              <button aria-label="Edit" onClick=${() => setEditing(m.id)}><${Icon.edit} /></button>
              <button aria-label="Delete" onClick=${async () => {
                if (await ui.confirm({ title: 'Forget this?', message: truncate(m.text, 160), confirmText: 'Forget', danger: true })) await app.memory.remove(m.id);
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
    <textarea class="textarea" style="min-height:80px" placeholder="e.g. Prefers morning meetings before 10am." value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>
    <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
      <select class="select" style="width:auto;padding:8px 10px" value=${type} onChange=${(e) => setType(e.currentTarget.value)}>
        ${MEMORY_TYPES.map((t) => html`<option value=${t}>${t}</option>`)}
      </select>
      <label class="hint">Importance <input type="range" min="1" max="10" value=${importance} onInput=${(e) => setImportance(+e.currentTarget.value)} /> ${importance}</label>
      <span style="flex:1"></span>
      <button class="btn small" onClick=${onCancel}>Cancel</button>
      <button class="btn small primary" disabled=${!text.trim()} onClick=${() => onSave({ text: text.trim(), type, importance })}>Save</button>
    </div>
  </div>`;
}

function CoreMemory({ agent }) {
  const app = useApp();
  const ui = useUi();
  const core = { persona: '', human: '', notes: '', ...(agent.core || {}) };
  const save = async (key, value) => {
    await app.updateAgent(agent.id, { core: { ...core, [key]: value } });
    ui.toast('Saved');
  };
  const fields = [
    ['persona', 'Persona', `Who ${agent.name} is and how it sees its role. The bot updates this as it learns.`],
    ['human', 'About you', 'A compact profile of you, always in view. Refreshed from memories over time.'],
    ['notes', 'Notes', 'Current goals, ongoing tasks and reminders the bot keeps for itself.'],
  ];
  return html`
    <p class="hint" style="font-size:14px;margin:4px 4px 6px">Core memory is always in ${agent.name}'s context (unlike long-term memories, which are recalled when relevant).</p>
    ${fields.map(([k, label, hint]) => html`<${Field} key=${k} label=${label} hint=${hint}>
      <textarea class="textarea" value=${core[k]} onChange=${(e) => save(k, e.currentTarget.value)}></textarea>
    <//>`)}`;
}
