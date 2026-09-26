import { html, useState } from '../../vendor/preact.js';
import { useApp, useUi, useAsync } from './hooks.js';
import { Sheet, Field, Segmented, Toggle } from './components.js';
import { Icon } from './icons.js';
import { Avatar } from './avatar.js';
import { normalizeSchedule } from '../core/routines.js';
import { dateText, dateTimeText, scheduleText, tr, trn } from './i18n.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** A day of the week (0 is Sunday), short ("Mon"), in the app's language. */
const dayName = (day) => dateText(new Date(2024, 0, 7 + day), { weekday: 'short' }); // 7 January 2024 was a Sunday

export function RoutinesSheet({ agentId, onClose }) {
  const app = useApp();
  const ui = useUi();
  const agent = agentId ? app.getAgent(agentId) : null;
  const [adding, setAdding] = useState(false);
  // Each routine shows its title, schedule and switch; tapping it shows what
  // it does, its runs, Run now and Delete.
  const [open, setOpen] = useState(null);
  const { data: list = [] } = useAsync(() => app.routines.list(agentId), [agentId], ['routines']);
  return html`
    <${Sheet} title=${agent ? tr("{name}'s routines", { name: agent.name }) : tr('Routines')} onClose=${onClose}>
      <p class="hint" style="font-size:14px;margin:2px 4px 12px">${tr('Routines run while Holly Bot is open (on any device tab). If a run is missed, it runs next time you open the app.')}</p>
      ${!adding && html`<button class="btn block" onClick=${() => setAdding(true)}><${Icon.plus} size="18" /> ${tr('New routine')}</button>`}
      ${adding && html`<${RoutineEditor} agents=${agent ? [agent] : app.listAgents()} onCancel=${() => setAdding(false)} onSave=${async (r) => {
        await app.routines.create(r);
        setAdding(false);
        ui.toast(tr('Routine scheduled'));
      }} />`}
      ${!list.length && !adding && html`<div class="empty-home" style="padding:40px 10px"><p>${tr('No routines yet. You can also just ask a bot: “Every weekday at 8am, send me a news brief.”')}</p></div>`}
      ${list.map((r) => {
        const a = app.getAgent(r.agentId);
        const isOpen = open === r.id;
        return html`<div class="mem" key=${r.id}>
          <div class="routine-row">
            ${!agent && a && html`<${Avatar} shape=${a.shape} color=${a.color} size=${26} />`}
            <button class="routine-head" aria-expanded=${isOpen} onClick=${() => setOpen(isOpen ? null : r.id)}>
              <div class="routine-title">${r.title}</div>
              <div class="hint" style="padding:0">${scheduleText(r.schedule)} · ${r.enabled && r.nextRunAt ? tr('next {when}', { when: dateTimeText(r.nextRunAt, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }) : r.enabled ? tr('done') : tr('paused')}</div>
            </button>
            <${Toggle} small on=${r.enabled} onChange=${(v) => app.routines.update(r.id, { enabled: v })} label=${tr('Enabled')} />
          </div>
          ${isOpen && html`
            <div class="txt" style="font-size:14.5px;color:var(--text-2);margin-top:8px">${r.prompt}</div>
            <div class="meta">
              <span>${trn(r.runCount || 0, '{n} run', '{n} runs')}${r.lastRunAt ? ` · ${tr('last {when}', { when: dateTimeText(r.lastRunAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) })}` : ''}</span>
              <span class="acts">
                <button aria-label=${tr('Run now')} onClick=${() => { app.runtime.runRoutine(r); ui.toast(tr('Running now')); }}><${Icon.play} /></button>
                <button aria-label=${tr('Delete')} onClick=${async () => {
                  if (await ui.confirm({ title: tr('Delete “{title}”?', { title: r.title }), confirmText: tr('Delete'), danger: true })) await app.routines.remove(r.id);
                }}><${Icon.trash} /></button>
              </span>
            </div>`}
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
    ${agents.length > 1 && html`<${Field} label=${tr('Bot')}><select class="select" value=${agentId} onChange=${(e) => setAgentId(e.currentTarget.value)}>
      ${agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select><//>`}
    <${Field} label=${tr('Title')}><input class="input" placeholder=${tr('Morning brief')} value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} /><//>
    <${Field} label=${tr('What should the bot do?')}><textarea class="textarea" placeholder=${tr('Check my calendar and the weather in Austin, then send me a 3-line brief.')} value=${prompt} onInput=${(e) => setPrompt(e.currentTarget.value)}></textarea><//>
    <${Segmented} value=${kind} onChange=${setKind} options=${[{ value: 'once', label: tr('Once') }, { value: 'daily', label: tr('Daily') }, { value: 'weekly', label: tr('Weekly') }, { value: 'interval', label: tr('Every…') }]} />
    ${kind === 'once' && html`<${Field} label=${tr('When')}><input class="input" type="datetime-local" value=${at} onInput=${(e) => setAt(e.currentTarget.value)} /><//>`}
    ${(kind === 'daily' || kind === 'weekly') && html`<${Field} label=${tr('Time')}><input class="input" type="time" value=${time} onInput=${(e) => setTime(e.currentTarget.value)} /><//>`}
    ${kind === 'weekly' && html`<div class="chips" style="margin:6px 0 10px">${DAY_KEYS.map((d, i) => html`<button key=${d} class=${`chip ${days.includes(d) ? 'on' : ''}`}
      onClick=${() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>${dayName(i)}</button>`)}</div>`}
    ${kind === 'interval' && html`<${Field} label=${tr('Every (minutes, min 15)')}><input class="input" type="number" min="15" value=${every} onInput=${(e) => setEvery(+e.currentTarget.value)} /><//>`}
    <div class="btn-row" style="justify-content:flex-end;margin-top:10px">
      <button class="btn small" onClick=${onCancel}>${tr('Cancel')}</button>
      <button class="btn small primary" disabled=${!prompt.trim() || !agentId} onClick=${save}>${tr('Schedule')}</button>
    </div>
  </div>`;
}
