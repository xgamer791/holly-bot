import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact.js';
import { useApp, useUi, haptic } from './hooks.js';
import { Avatar, SHAPES, SHAPE_KEYS, COLORS, COLOR_KEYS, COLOR_NAMES, THINKING } from './avatar.js';
import { THINKING_KEYS } from '../core/constants.js';
import { JOB_CHARS, JOB_WORDS, clipWords, jobLine, wordCount } from '../core/brief.js';
import { Sheet, Field, Segmented } from './components.js';
import { Icon } from './icons.js';
import { number, tr, trn } from './i18n.js';

/**
 * A bot's job, or its rules, in the user's words (src/core/brief.js): folded
 * away to a few lines (for a long job, the summary Holly Bot's AI wrote of it,
 * `summary`), which open to the whole of it, to read or edit, in a box that
 * grows to fit it. Empty, it's open, to be written in. `value` and `onInput`:
 * the text as it's written; `onDone`: once it's written (the box loses focus,
 * or folds away). JOB_WORDS words at most, which it counts. `big`: as in
 * Create New Bot.
 */
export function JobBox({ value, onInput, onDone, summary = '', placeholder, label, big = false, rules = false }) {
  const [open, setOpen] = useState(() => !value.trim());
  const text = value.trim();
  const cls = `job-box${big ? ' big' : ''}${rules ? ' rules' : ''}`;
  if (!open && text) {
    return html`
      <button class=${`${cls} folded`} aria-expanded="false" onClick=${() => setOpen(true)}>
        <span class="job-text">${summary || text}</span>
        <span class="job-meta">
          <span>${summary ? `${tr('Summary')} · ` : ''}${trn(wordCount(text), '{n} word', '{n} words')}</span>
          <span class="job-toggle"><${Icon.expand} size="18" /></span>
        </span>
      </button>`;
  }
  const words = wordCount(value);
  return html`
    <div class=${`${cls} open`}>
      <${WordsArea} value=${value} onInput=${onInput} onDone=${onDone} placeholder=${placeholder} label=${label} />
      ${text && html`
        <div class="job-meta">
          <span class=${words >= JOB_WORDS ? 'full' : ''}>${tr('{count} / {max} words', { count: number(words), max: number(JOB_WORDS) })}</span>
          <button class="job-toggle" aria-label=${tr('Minimize')} aria-expanded="true" onClick=${() => {
            onDone?.(value);
            setOpen(false);
          }}><${Icon.collapse} size="18" /></button>
        </div>`}
    </div>`;
}

/**
 * A bot's job or rules (`field`: 'description' or 'rules') in its profile or
 * its memory, in a JobBox: saved once written (the box loses focus or folds
 * away, or the sheet closes), and a new job or new rules get the bot a new
 * briefing (src/core/app.js updateAgent). `summary`: of the job as it's saved.
 */
export function AgentText({ agent, field, summary = '', ...props }) {
  const app = useApp();
  const saved = agent[field] || '';
  const [text, setText] = useState(saved);
  // What's being written, until it's saved.
  const draft = useRef(null);
  // Changed elsewhere (its profile or its memory, another device) while not being written here.
  useEffect(() => {
    if (draft.current == null) setText(saved);
  }, [saved]);
  const save = () => {
    const next = draft.current?.trim();
    draft.current = null;
    if (next != null && next !== (app.getAgent(agent.id)?.[field] || '')) app.updateAgent(agent.id, { [field]: next });
  };
  // What's being written as the sheet closes is kept too.
  useEffect(() => save, []);
  return html`<${JobBox} ...${props} value=${text} summary=${text.trim() === saved.trim() ? summary : ''} onDone=${save} onInput=${(v) => {
    draft.current = v;
    setText(v);
  }} />`;
}

/** The box a job or rules are written in: it grows to fit what's in it, and
 * takes JOB_WORDS words at most (limitWords). */
function WordsArea({ value, onInput, onDone, placeholder, label }) {
  const ref = useRef(null);
  // The text as it was before the edit being made (an IME composition keeps
  // it until it's done), and as it was last passed on.
  const before = useRef(value);
  const sent = useRef(value);
  if (value !== sent.current) before.current = sent.current = value;
  useLayoutEffect(() => fit(ref.current), [value]);
  useEffect(() => {
    const refit = () => fit(ref.current);
    addEventListener('resize', refit);
    return () => removeEventListener('resize', refit);
  }, []);
  const edit = (el, composing) => {
    const next = composing ? el.value : limitWords(el, before.current);
    if (!composing) before.current = next;
    sent.current = next;
    onInput(next);
  };
  return html`<textarea ref=${ref} class="job-area" rows="1" maxlength=${JOB_CHARS} value=${value} placeholder=${placeholder} aria-label=${label}
    onInput=${(e) => edit(e.currentTarget, e.isComposing)} oncompositionend=${(e) => edit(e.currentTarget, false)}
    onBlur=${(e) => onDone?.(e.currentTarget.value)}></textarea>`;
}

/** What's in the box `el` after an edit, JOB_WORDS words at most: an edit
 * that goes past them keeps what was there, and as much of what came in as
 * fits, the way maxlength does with characters. `before`: the text before it. */
function limitWords(el, before) {
  const next = el.value;
  if (wordCount(next) <= JOB_WORDS) return next;
  // What the edit changed: what's between the text that stayed the same at the start and at the end.
  let start = 0;
  while (start < before.length && start < next.length && before[start] === next[start]) start++;
  let end = 0;
  while (end < before.length - start && end < next.length - start && before[before.length - 1 - end] === next[next.length - 1 - end]) end++;
  const head = next.slice(0, start);
  const tail = next.slice(next.length - end);
  const room = JOB_WORDS - wordCount(head + tail);
  const kept = head + (room > 0 ? clipWords(next.slice(start, next.length - end), room) : '');
  let out = kept + tail;
  let caret = kept.length;
  if (wordCount(out) > JOB_WORDS) {
    out = clipWords(before);
    caret = Math.min(start, out.length);
  }
  el.value = out;
  el.setSelectionRange(caret, caret);
  return out;
}

/** Grows (or shrinks) a box to fit what's in it, without the sheet it's on jumping. */
function fit(el) {
  if (!el) return;
  const scroller = el.closest('.sheet-body');
  const top = scroller?.scrollTop;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
}

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
  const [rules, setRules] = useState('');
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
    // Its job and rules: kept in its memory and read before every chat, and Holly Bot's AI briefs it on them (src/core/brief.js).
    const agent = await app.createAgent({ name: name.trim(), description: job.trim(), rules: rules.trim(), shape, color, thinking });
    onClose();
    ui.navigate(`#/chat/dm_${agent.id}`);
  };

  return html`
    <${Sheet} title=${tr('Create New Bot')} onClose=${onClose}
      footer=${html`<button class="btn block big ${valid ? 'primary' : ''}" disabled=${!valid || busy} onClick=${create}>${tr('Create')}</button>`}>
      <div class="create-preview"><${Avatar} shape=${shape} color=${color} size=${Math.min(170, Math.round(innerWidth * 0.36))} live working=${preview || busy} anim=${thinking} /></div>
      <input class="name-input" placeholder=${tr('Name your Bot')} maxlength="40" value=${name} aria-label=${tr('Bot name')}
        onInput=${(e) => setName(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Enter' && create()} />
      <${JobBox} big value=${job} onInput=${setJob} label=${tr("Bot's job")}
        placeholder=${tr("What's its job? e.g. Plan my meals for the week and make the shopping list")} />
      <div class="hint job-hint">${tr('It keeps this in its memory and reads it before every chat, so it knows exactly what its role is.')}</div>
      <${JobBox} big rules value=${rules} onInput=${setRules} label=${tr("Bot's rules")}
        placeholder=${tr('Rules it must always follow (optional), e.g. Never send an email without my OK')} />
      <div class="hint job-hint">${tr("Hard rules it keeps in its memory and follows in every chat. If one goes against Holly Bot's own rules, it won't follow it, and it will tell you why.")}</div>
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
            <div class="label"><div class="t">${a.name}</div>${jobLine(a, 90) && html`<div class="s">${jobLine(a, 90)}</div>`}</div>
            <span class=${`ok-check`} style=${picked.includes(a.id) ? '' : 'visibility:hidden'}><${Icon.check} /></span>
          </button>`)}
      </div>
    <//>`;
}
