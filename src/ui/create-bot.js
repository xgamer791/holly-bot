import { html, useState } from '../../vendor/preact.js';
import { useApp, useUi, haptic } from './hooks.js';
import { Avatar, SHAPES, SHAPE_KEYS, COLORS, COLOR_KEYS } from './avatar.js';
import { Sheet, Field, Segmented } from './components.js';
import { Icon } from './icons.js';

/** Shape + color picker grid used by "Create New Bot" and the bot profile. */
export function LookPicker({ shape, color, onShape, onColor }) {
  const row1 = COLOR_KEYS.slice(0, 6);
  const row2 = COLOR_KEYS.slice(6);
  return html`
    <div class="picker shapes" role="radiogroup" aria-label="Shape">
      ${SHAPE_KEYS.map((k) => html`
        <button key=${k} role="radio" aria-checked=${shape === k} aria-label=${SHAPES[k].label} class=${`pick ${shape === k ? 'on' : ''}`} onClick=${() => onShape(k)}>
          <svg viewBox="0 0 100 100" width="36" height="36"><path d=${SHAPES[k].d} fill=${COLORS[color] || COLORS.green} /></svg>
        </button>`)}
    </div>
    <div class="picker colors" role="radiogroup" aria-label="Color">
      ${row1.map((k) => swatch(k, color, onColor))}
      <div class="row2">${row2.map((k) => swatch(k, color, onColor))}</div>
    </div>`;
}

function swatch(k, color, onColor) {
  return html`<button key=${k} role="radio" aria-checked=${color === k} aria-label=${k} class=${`swatch ${color === k ? 'on' : ''}`} onClick=${() => onColor(k)}>
    <span style=${`background:${COLORS[k]}`}></span></button>`;
}

export function CreateBotSheet({ onClose }) {
  const app = useApp();
  const ui = useUi();
  const [name, setName] = useState('');
  const [shape, setShape] = useState('squircle');
  const [color, setColor] = useState('green');
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0;

  const create = async () => {
    if (!valid || busy) return;
    if (app.findAgent(name.trim()) && app.findAgent(name.trim()).name.toLowerCase() === name.trim().toLowerCase()) {
      ui.toast('You already have a bot with that name.', { error: true });
      return;
    }
    setBusy(true);
    haptic(app, 'heavy');
    const agent = await app.createAgent({ name: name.trim(), shape, color });
    onClose();
    ui.navigate(`#/chat/dm_${agent.id}`);
  };

  return html`
    <${Sheet} title="Create New Bot" onClose=${onClose}
      footer=${html`<button class="btn block big ${valid ? 'primary' : ''}" disabled=${!valid || busy} onClick=${create}>Create</button>`}>
      <div class="create-preview"><${Avatar} shape=${shape} color=${color} size=${Math.min(170, Math.round(innerWidth * 0.36))} live /></div>
      <input class="name-input" placeholder="Name your Bot" maxlength="40" value=${name} aria-label="Bot name"
        onInput=${(e) => setName(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && create()} />
      <${LookPicker} shape=${shape} color=${color} onShape=${(s) => { setShape(s); haptic(app); }} onColor=${(c) => { setColor(c); haptic(app); }} />
    <//>`;
}

export function NewGroupSheet({ onClose }) {
  const app = useApp();
  const ui = useUi();
  const agents = app.listAgents();
  const [picked, setPicked] = useState([]);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('auto');
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const valid = picked.length >= 2;
  const create = async () => {
    if (!valid) return;
    const g = await app.createGroup({ title, agentIds: picked, mode });
    onClose();
    ui.navigate(`#/chat/${g.id}`);
  };
  return html`
    <${Sheet} title="New Group Chat" onClose=${onClose}
      footer=${html`<button class="btn block big ${valid ? 'primary' : ''}" disabled=${!valid} onClick=${create}>Create Group</button>`}>
      ${agents.length < 2 && html`<p class="hint" style="font-size:15px;margin:8px 4px 16px">Group chats need at least two bots. Create another bot first.</p>`}
      <${Field} label="Group name (optional)">
        <input class="input" placeholder=${picked.map((id) => app.getAgent(id)?.name).join(', ') || 'e.g. Launch team'} value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} />
      <//>
      <${Field} label="Who replies" hint=${mode === 'auto' ? 'Holly picks the best bot(s) for each message. Use @Name to ask someone directly.' : mode === 'all' ? 'Every bot answers every message (bots can [PASS]).' : 'Only bots you @mention reply.'}>
        <${Segmented} value=${mode} onChange=${setMode} options=${[{ value: 'auto', label: 'Smart' }, { value: 'all', label: 'Everyone' }, { value: 'mention', label: '@Mentions' }]} />
      <//>
      <div class="group" style="margin-top:18px">
        ${agents.map((a) => html`
          <button key=${a.id} class="row" onClick=${() => toggle(a.id)}>
            <${Avatar} shape=${a.shape} color=${a.color} size=${36} />
            <div class="label"><div class="t">${a.name}</div>${a.description && html`<div class="s">${a.description}</div>`}</div>
            <span class=${`ok-check`} style=${picked.includes(a.id) ? '' : 'visibility:hidden'}><${Icon.check} /></span>
          </button>`)}
      </div>
    <//>`;
}
