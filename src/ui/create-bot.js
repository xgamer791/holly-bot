import { html, useEffect, useRef, useState } from '../../vendor/preact.js';
import { useApp, useUi, haptic } from './hooks.js';
import { Avatar, SHAPES, SHAPE_KEYS, COLORS, COLOR_KEYS, COLOR_NAMES, THINKING } from './avatar.js';
import { THINKING_KEYS } from '../core/constants.js';
import { Sheet, Field, Segmented } from './components.js';
import { Icon } from './icons.js';
import { tr } from './i18n.js';
import { truncate } from '../core/util.js';

/** How long a bot's job can be, in its words (Create New Bot, its profile). */
export const JOB_MAX = 1000;

/** Shape, color and thinking-style pickers used by "Create New Bot" and the bot profile. */
export function LookPicker({ shape, color, thinking, onShape, onColor, onThinking }) {
  const row1 = COLOR_KEYS.slice(0, 6);
  const row2 = COLOR_KEYS.slice(6);
  return html`
    <div class="picker shapes" role="radiogroup" aria-label=${tr('Shape')}>
      ${SHAPE_KEYS.map((k) => html`
        <button key=${k} role="radio" aria-checked=${shape === k} aria-label=${tr(SHAPES[k].label)} class=${`pick ${shape === k ? 'on' : ''}`} onClick=${() => onShape(k)}>
          <svg viewBox="0 0 100 100" width="36" height="36"><path d=${SHAPES[k].d} fill=${COLORS[color] || COLORS.green} /></svg>
        </button>`)}
    </div>
    <div class="picker colors" role="radiogroup" aria-label=${tr('Color')}>
      ${row1.map((k) => swatch(k, color, onColor))}
      <div class="row2">${row2.map((k) => swatch(k, color, onColor))}</div>
    </div>
    ${onThinking && html`
      <div class="picker-label">${tr('How it thinks')}</div>
      <div class="picker thinking" role="radiogroup" aria-label=${tr('Thinking animation')}>
        ${THINKING_KEYS.map((k) => html`
          <button key=${k} role="radio" aria-checked=${thinking === k} class=${`think-pick ${thinking === k ? 'on' : ''}`} onClick=${() => onThinking(k)}>
            <${Avatar} shape=${shape} color=${color} size=${38} working anim=${k} />
            <span>${tr(THINKING[k].label)}</span>
          </button>`)}
      </div>`}`;
}

/** Plays a bot's thinking animation for a few seconds after it is picked. */
export function usePreview() {
  const [on, setOn] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [on, () => {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), 4500);
  }];
}

function swatch(k, color, onColor) {
  return html`<button key=${k} role="radio" aria-checked=${color === k} aria-label=${tr(COLOR_NAMES[k])} class=${`swatch ${color === k ? 'on' : ''}`} onClick=${() => onColor(k)}>
    <span style=${`background:${COLORS[k]}`}></span></button>`;
}

export function CreateBotSheet({ onClose }) {
  const app = useApp();
  const ui = useUi();
  const [name, setName] = useState('');
  const [job, setJob] = useState('');
  const [shape, setShape] = useState('squircle');
  const [color, setColor] = useState('green');
  const [thinking, setThinking] = useState(() => THINKING_KEYS[Math.floor(Math.random() * THINKING_KEYS.length)]);
  const [preview, play] = usePreview();
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0;

  const create = async () => {
    if (!valid || busy) return;
    if (app.findAgent(name.trim()) && app.findAgent(name.trim()).name.toLowerCase() === name.trim().toLowerCase()) {
      ui.toast(tr('You already have a bot with that name.'), { error: true });
      return;
    }
    setBusy(true);
    haptic(app, 'heavy');
    // Its job: Holly Bot's AI reads it and briefs the bot on it (src/core/brief.js).
    const agent = await app.createAgent({ name: name.trim(), description: job.trim(), shape, color, thinking });
    onClose();
    ui.navigate(`#/chat/dm_${agent.id}`);
  };

  return html`
    <${Sheet} title=${tr('Create New Bot')} onClose=${onClose}
      footer=${html`<button class="btn block big ${valid ? 'primary' : ''}" disabled=${!valid || busy} onClick=${create}>${tr('Create')}</button>`}>
      <div class="create-preview"><${Avatar} shape=${shape} color=${color} size=${Math.min(170, Math.round(innerWidth * 0.36))} live working=${preview || busy} anim=${thinking} /></div>
      <input class="name-input" placeholder=${tr('Name your Bot')} maxlength="40" value=${name} aria-label=${tr('Bot name')}
        onInput=${(e) => setName(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && create()} />
      <textarea class="job-input" rows="3" maxlength=${JOB_MAX} value=${job} aria-label=${tr("Bot's job")}
        placeholder=${tr("What's its job? e.g. Plan my meals for the week and make the shopping list")}
        onInput=${(e) => setJob(e.currentTarget.value)}></textarea>
      <div class="hint job-hint">${tr('It gets a briefing on this, so it knows exactly what its role is.')}</div>
      <${LookPicker} shape=${shape} color=${color} thinking=${thinking}
        onShape=${(s) => { setShape(s); haptic(app); }} onColor=${(c) => { setColor(c); haptic(app); }}
        onThinking=${(k) => { setThinking(k); play(); haptic(app); }} />
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
    <${Sheet} title=${tr('New Group Chat')} onClose=${onClose}
      footer=${html`<button class="btn block big ${valid ? 'primary' : ''}" disabled=${!valid} onClick=${create}>${tr('Create Group')}</button>`}>
      ${agents.length < 2 && html`<p class="hint" style="font-size:15px;margin:8px 4px 16px">${tr('Group chats need at least two bots. Create another bot first.')}</p>`}
      <${Field} label=${tr('Group name (optional)')}>
        <input class="input" placeholder=${picked.map((id) => app.getAgent(id)?.name).join(', ') || tr('e.g. Launch team')} value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} />
      <//>
      <${Field} label=${tr('Who replies')} hint=${mode === 'auto' ? tr('Holly picks the best bot(s) for each message. Use @Name to ask someone directly.') : mode === 'all' ? tr('Every bot answers every message (bots can [PASS]).') : tr('Only bots you @mention reply.')}>
        <${Segmented} value=${mode} onChange=${setMode} options=${[{ value: 'auto', label: tr('Smart') }, { value: 'all', label: tr('Everyone') }, { value: 'mention', label: tr('@Mentions') }]} />
      <//>
      <div class="group" style="margin-top:18px">
        ${agents.map((a) => html`
          <button key=${a.id} class="row" onClick=${() => toggle(a.id)}>
            <${Avatar} shape=${a.shape} color=${a.color} size=${36} />
            <div class="label"><div class="t">${a.name}</div>${a.description && html`<div class="s">${truncate(a.description.replace(/\s+/g, ' ').trim(), 90)}</div>`}</div>
            <span class=${`ok-check`} style=${picked.includes(a.id) ? '' : 'visibility:hidden'}><${Icon.check} /></span>
          </button>`)}
      </div>
    <//>`;
}
