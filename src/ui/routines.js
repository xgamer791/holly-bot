import { html, useState } from '../../vendor/preact.js';
import { useApp, useUi, useAsync } from './hooks.js';
import { Sheet, Field, Segmented, Toggle } from './components.js';
import { Icon } from './icons.js';
import { Avatar } from './avatar.js';
import { describeSchedule, normalizeSchedule } from '../core/routines.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function RoutinesSheet({ agentId, onClose }) {
  const app = useApp();
  const ui = useUi();
  const agent = agentId ? app.getAgent(agentId) : null;
  const [adding, setAdding] = useState(false);
  const { data: list = [] } = useAsync(() => app.routines.list(agentId), [agentId], ['routines']);
  return html`
    <${Sheet} title=${agent ? `${agent.name}'s routines` : 'Routines'} onClose=${onClose}>
      <p class="hint" style="font-size:14px;margin:2px 4px 12px">Routines run while Holly Bot is open (on any device tab). If a run is missed, it runs next time you open the app.</p>
      ${!adding && html`<button class="btn block" onClick=${() => setAdding(true)}><${Icon.plus} size="18" /> New routine</button>`}
      ${adding && html`<${RoutineEditor} agents=${agent ? [agent] : app.listAgents()} onCancel=${() => setAdding(false)} onSave=${async (r) => {
        await app.routines.create(r);
        setAdding(false);
        ui.toast('Routine scheduled');
      }} />`}
      ${!list.length && !adding && html`<div class="empty-home" style="padding:40px 10px"><p>No routines yet. You can also just ask a bot: “Every weekday at 8am, send me a news brief.”</p></div>`}
      ${list.map((r) => {
        const a = app.getAgent(r.agentId);
        return html`<div class="mem" key=${r.id}>
          <div style="display:flex;align-items:center;gap:10px">
            ${!agent && a && html`<${Avatar} shape=${a.shape} color=${a.color} size=${26} />`}
            <div style="flex:1;min-width:0"><div style="font-weight:600">${r.title}</div>
              <div class="hint" style="padding:0">${describeSchedule(r.schedule)} · ${r.enabled && r.nextRunAt ? `next ${new Date(r.nextRunAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : r.enabled ? 'done' : 'paused'}</div></div>
            <${Toggle} small on=${r.enabled} onChange=${(v) => app.routines.update(r.id, { enabled: v })} label="Enabled" />
          </div>
          <div class="txt" style="font-size:14.5px;color:var(--text-2);margin-top:8px">${r.prompt}</div>
          <div class="meta">
            <span>${r.runCount || 0} run${r.runCount === 1 ? '' : 's'}${r.lastRunAt ? ` · last ${new Date(r.lastRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}</span>
            <span class="acts">
              <button aria-label="Run now" onClick=${() => { app.runtime.runRoutine(r); ui.toast('Running now'); }}><${Icon.play} /></button>
              <button aria-label="Delete" onClick=${async () => {
                if (await ui.confirm({ title: `Delete “${r.title}”?`, confirmText: 'Delete', danger: true })) await app.routines.remove(r.id);
              }}><${Icon.trash} /></button>
            </span>
          </div>
        </div>`;
      })}
    <//>`;
}

function RoutineEditor({ agents, onSave, onCancel }) {
  const ui = useUi();
  const [agentId, setAgentId] = useState(agents[0]?.id || '');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState('daily');
  const [time, setTime] = useState('08:00');
  const [days, setDays] = useState(['mon', 'tue', 'wed', 'thu', 'fri']);
  const [at, setAt] = useState(() => {
    const d = new Date(Date.now() + 3600000);
    d.setMinutes(0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [every, setEvery] = useState(60);
  const save = () => {
    try {
      const schedule = normalizeSchedule({ kind, time, days, at, everyMinutes: every });
      onSave({ agentId, title: title.trim() || prompt.slice(0, 40), prompt: prompt.trim(), schedule });
    } catch (err) {
      ui.toast(err.message, { error: true });
    }
  };
  return html`<div class="mem">
    ${agents.length > 1 && html`<${Field} label="Bot"><select class="select" value=${agentId} onChange=${(e) => setAgentId(e.currentTarget.value)}>
      ${agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select><//>`}
    <${Field} label="Title"><input class="input" placeholder="Morning brief" value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} /><//>
    <${Field} label="What should the bot do?"><textarea class="textarea" placeholder="Check my calendar and the weather in Austin, then send me a 3-line brief." value=${prompt} onInput=${(e) => setPrompt(e.currentTarget.value)}></textarea><//>
    <${Segmented} value=${kind} onChange=${setKind} options=${[{ value: 'once', label: 'Once' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'interval', label: 'Every…' }]} />
    ${kind === 'once' && html`<${Field} label="When"><input class="input" type="datetime-local" value=${at} onInput=${(e) => setAt(e.currentTarget.value)} /><//>`}
    ${(kind === 'daily' || kind === 'weekly') && html`<${Field} label="Time"><input class="input" type="time" value=${time} onInput=${(e) => setTime(e.currentTarget.value)} /><//>`}
    ${kind === 'weekly' && html`<div class="chips" style="margin:6px 0 10px">${DAY_KEYS.map((d) => html`<button key=${d} class=${`chip ${days.includes(d) ? 'on' : ''}`}
      onClick=${() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>${d[0].toUpperCase() + d.slice(1)}</button>`)}</div>`}
    ${kind === 'interval' && html`<${Field} label="Every (minutes, min 15)"><input class="input" type="number" min="15" value=${every} onInput=${(e) => setEvery(+e.currentTarget.value)} /><//>`}
    <div class="btn-row" style="justify-content:flex-end;margin-top:10px">
      <button class="btn small" onClick=${onCancel}>Cancel</button>
      <button class="btn small primary" disabled=${!prompt.trim() || !agentId} onClick=${save}>Schedule</button>
    </div>
  </div>`;
}
