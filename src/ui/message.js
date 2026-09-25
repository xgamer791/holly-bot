import { html, useState, useEffect } from '../../vendor/preact.js';
import { useApp, useUi, useAsync, haptic } from './hooks.js';
import { Avatar, botActivity, thinkingOf } from './avatar.js';
import { Icon, fileIcon } from './icons.js';
import { Markdown } from './markdown.js';
import { copyText } from './components.js';
import { formatBytes, truncate } from '../core/util.js';
import { finalText } from '../core/runtime.js';
import { BUILTIN_TOOLS } from '../core/tools/index.js';
import { speak } from './speech.js';
import { dateTimeText, language, mark, phraseOr, scheduleText, tr, trn } from './i18n.js';

const LETTERS = 'ABCDEFGH';
/** A delegated task's status (src/core/runtime.js delegate), in words. */
const TASK_STATUS = { done: mark('done'), failed: mark('failed'), stopped: mark('stopped') };

export function MessageView({ msg, thread, showAuthor, isLast }) {
  if (msg.hidden || msg.quiet) return null;
  if (msg.authorType === 'system') return html`<${SystemNotice} msg=${msg} />`;
  if (msg.authorType === 'user') return html`<${UserMessage} msg=${msg} />`;
  return html`<${BotMessage} msg=${msg} thread=${thread} showAuthor=${showAuthor} isLast=${isLast} />`;
}

function SystemNotice({ msg }) {
  const text = (msg.parts || []).map((p) => p.text).join(' ');
  if (msg.routineId) {
    const title = text.match(/Routine “([^”]+)”/)?.[1] || tr('Routine');
    return html`<div class="notice routine"><${Icon.clock} size="14" class="inline" /> ${tr('Routine: {title}', { title })}</div>`;
  }
  return html`<div class="notice">${(msg.parts || []).map((p) => phraseOr(p.say, p.text)).join(' ')}</div>`;
}

function UserMessage({ msg }) {
  const app = useApp();
  const text = (msg.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const images = (msg.parts || []).filter((p) => p.type === 'image');
  const files = (msg.parts || []).filter((p) => p.type === 'file');
  return html`
    <div class="msg user">
      ${(images.length > 0 || files.length > 0) && html`<div class="att-row">
        ${images.map((p, i) => html`<img key=${i} class="att-img" alt=${p.name || tr('Image')} src=${imgSrc(app, p)} />`)}
        ${files.map((p, i) => html`<${FileChip} key=${`f${i}`} name=${p.name} size=${p.size} mime=${p.mime} fileId=${p.fileId} app=${app} />`)}
      </div>`}
      ${text && html`<div class="bubble">${renderUserText(text)}</div>`}
    </div>`;
}

/** Image source for inline (base64) or server-hosted (remote mode) images. */
export function imgSrc(app, img) {
  if (img.data) return `data:${img.mime || 'image/png'};base64,${img.data}`;
  if (img.src) return app.assetUrl(img.src);
  return img.dataUrl || '';
}

function renderUserText(text) {
  // Preserve line breaks; highlight @mentions.
  return text.split('\n').map((line, i) => html`${i ? html`<br />` : null}${line.split(/(@[\p{L}\p{N}_.-]+)/u).map((seg) => (seg.startsWith('@') ? html`<b>${seg}</b>` : seg))}`);
}

function FileChip({ name, size, mime, fileId }) {
  const ui = useUi();
  const Ic = fileIcon(mime, name);
  return html`<button class="file-card" onClick=${() => fileId && ui.openFile(fileId)}>
    <span class="fi"><${Ic} /></span>
    <span style="min-width:0"><div class="fn">${name}</div><div class="fs">${formatBytes(size)}</div></span>
  </button>`;
}

function BotMessage({ msg, thread, showAuthor, isLast }) {
  const app = useApp();
  const ui = useUi();
  const agent = app.getAgent(msg.authorId);
  const streaming = msg.status === 'streaming';
  const text = finalText(msg);
  const citations = dedupeSources(msg.steps.flatMap((s) => s.citations || []));

  if (msg.delivery?.kind === 'task_result') {
    return html`<${TaskResultCard} msg=${msg} agent=${agent} />`;
  }

  const lastStep = msg.steps[msg.steps.length - 1];
  // Its steps don't show, so a reply that hasn't said or sent anything (yet,
  // or before a new message cut it short) takes no room.
  const shown = citations.length || msg.memoryOps?.length || ['error', 'stopped'].includes(msg.status)
    || msg.steps.some((s) => s.text || s.notices?.length || (s.toolCalls || []).some(showsInChat));
  if (!shown) return null;

  return html`
    <div class="msg bot">
      ${showAuthor && agent && html`<div class="author"><${Avatar} shape=${agent.shape} color=${agent.color} size=${20} /> ${agent.name}</div>`}
      <div class="steps">
        ${msg.steps.map((step, i) => html`<${StepView} key=${step.id || i} step=${step} msg=${msg} streaming=${streaming && step === lastStep} />`)}
        ${citations.length > 0 && html`<${Sources} items=${citations} />`}
        ${msg.status === 'error' && html`<${ErrorCard} msg=${msg} />`}
        ${msg.status === 'stopped' && html`<${Stopped} thread=${thread} agent=${agent} text=${text} isLast=${isLast} />`}
        ${msg.memoryOps?.length > 0 && html`<button class="memory-note" onClick=${() => ui.openSheet('memory', { agentId: msg.authorId })}>
          <${Icon.brain} /> ${memorySummary(msg.memoryOps)}</button>`}
      </div>
      ${!streaming && text && msg.status !== 'error' && html`<div class="msg-actions">
        <button aria-label=${tr('Copy')} onClick=${() => copyText(text).then(() => ui.toast(tr('Copied')))}><${Icon.copy} /></button>
        <button aria-label=${tr('Read aloud')} onClick=${() => speak(text, app)}><${Icon.wave} /></button>
        ${isLast && thread?.kind !== 'agents' && html`<button aria-label=${tr('Regenerate')} onClick=${() => ui.regenerate(msg)}><${Icon.retry} /></button>`}
      </div>`}
    </div>`;
}

/** A reply that was stopped (Stop, or the app closing): says so when it had
 * written nothing, and, as the chat's last message, offers to carry on. The
 * bot hears it was stopped and picks the task back up (src/core/runtime.js
 * STOPPED_NOTE); in a group, the stopped bot is the one asked. */
function Stopped({ thread, agent, text, isLast }) {
  const app = useApp();
  const ui = useUi();
  const canContinue = isLast && agent && thread?.kind !== 'agents' && !app.runtime.isThreadBusy(thread.id);
  if (!canContinue) return text ? null : html`<div class="notice" style="align-self:flex-start">${tr('Stopped.')}</div>`;
  const carryOn = async () => {
    haptic(app);
    const words = thread.kind === 'group' ? `@${agent.name.replace(/\s+/g, '')} Continue` : 'Continue';
    try {
      await app.runtime.send(thread.id, { text: words });
    } catch (err) {
      ui.toast(err.message, { error: true });
    }
  };
  return html`<div class="stopped-row">
    ${!text && html`<span>${tr('Stopped.')}</span>`}
    <button class="continue-btn" onClick=${carryOn}><${Icon.play} size="14" /> ${tr('Continue')}</button>
  </div>`;
}

function memorySummary(ops) {
  const add = ops.filter((o) => o.op === 'add').length;
  const upd = ops.filter((o) => o.op === 'update').length;
  const del = ops.filter((o) => o.op === 'delete').length;
  const parts = [];
  if (add) parts.push(trn(add, 'Remembered {n} thing', 'Remembered {n} things'));
  if (upd) parts.push(trn(upd, 'updated {n}', 'updated {n}'));
  if (del) parts.push(trn(del, 'forgot {n}', 'forgot {n}'));
  return parts.join(language() === 'zh' ? '，' : ', ') || tr('Memory updated');
}

function StepView({ step, msg, streaming }) {
  return html`
    ${step.text && html`<div class="bubble"><${Markdown} text=${step.text} streaming=${streaming} /></div>`}
    ${(step.toolCalls || []).map((c) => html`<${ToolCallView} key=${c.id} call=${c} msg=${msg} />`)}
    ${(step.notices || []).map((n, i) => html`<div key=${i} class="notice" style="align-self:flex-start;text-align:left">${n}</div>`)}`;
}

/** Whether ToolCallView draws `call`: cards, what it sent or made, memory notes. */
function showsInChat(call) {
  const d = call.display;
  if (call.name === 'ask_user' || (call.approval?.status === 'pending' && !call.result)) return true;
  if (['agent_chat', 'file', 'image', 'routine', 'delegation'].includes(d?.kind)) return true;
  if (d?.kind === 'memory') return !call.result?.isError;
  return d?.kind === 'code' && !!call.result?.images?.length;
}

export function ToolCallView({ call, msg }) {
  const ui = useUi();
  if (call.name === 'ask_user') return html`<${QuestionCard} call=${call} msg=${msg} />`;
  if (call.approval?.status === 'pending' && !call.result) return html`<${ApprovalCard} call=${call} msg=${msg} />`;
  const d = call.display;
  if (d?.kind === 'agent_chat') return html`<${AgentChatCard} call=${call} d=${d} />`;
  if (d?.kind === 'file') return html`<${FileChip} name=${d.name} size=${d.size} mime=${d.mime} fileId=${d.fileId} />`;
  if (d?.kind === 'image') return html`<${GeneratedImage} fileId=${d.fileId} />`;
  if (d?.kind === 'memory' && !call.result?.isError) {
    const label = d.op === 'delete' ? tr('Forgot') : d.op === 'core' ? tr('Updated core memory') : d.op === 'update' ? tr('Updated memory') : d.shared ? tr('Saved to team memory') : tr('Saved to memory');
    return html`<button class="memory-note" onClick=${() => ui.openSheet('memory', { agentId: msg.authorId })}><${Icon.brain} /> ${d.op !== 'core' ? tr('{label}: {text}', { label, text: truncate(d.text, 90) }) : label}</button>`;
  }
  if (d?.kind === 'routine') {
    return html`<div class="agent-card"><div class="who"><${Icon.clock} size="16" /> ${tr('Routine scheduled')}</div>
      <div class="a"><b>${d.title}</b> — ${d.plan ? scheduleText(d.plan) : d.schedule}</div>
      <div class="q" style="margin:4px 0 0">${tr('Next run {when}', { when: d.nextRunAt ? dateTimeText(d.nextRunAt, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—' })}</div></div>`;
  }
  if (d?.kind === 'delegation') return html`<${DelegationCard} d=${d} />`;
  // Charts its code drew show; the step itself doesn't.
  if (d?.kind === 'code') return html`<${Charts} call=${call} />`;
  return null;
}

function Charts({ call }) {
  const app = useApp();
  return (call.result?.images || []).map((img, i) => html`<img key=${i} class="chart-img" style="max-width:min(88%,480px)" src=${imgSrc(app, img)} alt=${tr('Chart')} />`);
}

function QuestionCard({ call, msg }) {
  const app = useApp();
  const pending = call.pending || { question: call.args?.question, subtitle: call.args?.subtitle, options: call.args?.options || [], multiple: call.args?.allow_multiple };
  const [multi, setMulti] = useState([]);
  const answered = !!call.result && !call.dismissed;
  const open = !call.result && !call.dismissed && msg.status === 'waiting';
  const options = pending.options || [];

  const pick = (opt) => {
    haptic(app);
    if (pending.multiple) {
      setMulti((m) => (m.includes(opt) ? m.filter((x) => x !== opt) : [...m, opt]));
      return;
    }
    app.runtime.answer(msg.id, call.id, opt);
  };

  if (!open && !answered) {
    if (call.dismissed && !call.result) {
      return html`<div class="card"><div class="card-title" style="margin-right:0">${pending.question}</div><div class="card-sub" style="margin-bottom:0">${tr("Dismissed — answer in the chat below whenever you're ready.")}</div></div>`;
    }
    return null;
  }
  return html`
    <div class="card" role="group" aria-label=${pending.question}>
      <div class="card-title">${pending.question}</div>
      ${pending.subtitle && html`<div class="card-sub">${pending.subtitle}</div>`}
      ${open && html`<button class="card-x" aria-label=${tr('Dismiss')} onClick=${() => app.runtime.dismiss(msg.id, call.id)}><${Icon.x} /></button>`}
      ${open ? html`
        <div class="options">
          ${options.map((opt, i) => html`
            <button key=${opt} class=${`option ${multi.includes(opt) ? 'multi-on' : ''}`} onClick=${() => pick(opt)}>
              <span class="letter">${LETTERS[i] || i + 1}</span><span>${opt}</span>
              ${multi.includes(opt) && html`<${Icon.check} class="ok" />`}
            </button>`)}
        </div>
        ${pending.multiple && html`<button class="btn primary block" style="margin-top:12px" disabled=${!multi.length} onClick=${() => app.runtime.answer(msg.id, call.id, multi)}>${tr('Done')}</button>`}
        <div class="card-foot">${tr('Or answer in the chat below')}</div>`
      : html`
        <div class="options">
          <div class="option picked">
            <span>${call.answeredInChat ? tr('Answered in chat') : call.answer || tr('Answered')}</span>
            <${Icon.check} class="ok" />
          </div>
        </div>`}
    </div>`;
}

function ApprovalCard({ call, msg }) {
  const app = useApp();
  const agent = app.getAgent(msg.authorId);
  // What always asks (deleting a repository, or email for good) has no Always allow.
  const def = BUILTIN_TOOLS.find((t) => t.name === call.name);
  const always = !(typeof def?.alwaysAsk === 'function' ? def.alwaysAsk(call.args || {}) : def?.alwaysAsk);
  const decide = (d) => {
    haptic(app, 'heavy');
    app.runtime.approve(msg.id, call.id, d);
  };
  const label = phraseOr(call.say, call.label);
  return html`
    <div class="card approval" role="group" aria-label=${tr('Permission required')}>
      <div class="head"><${Icon.shield} /> ${tr('Permission required')}</div>
      <div class="card-sub" style="margin-bottom:10px">${tr('{bot} wants to {action}:', { bot: agent?.name || tr('Your bot'), action: label ? label.charAt(0).toLowerCase() + label.slice(1) : call.name })}</div>
      <div class="cmd">${phraseOr(call.approval.say, call.approval.summary)}</div>
      <div class="btn-row">
        <button class="btn" onClick=${() => decide('deny')}>${tr('Deny')}</button>
        ${always && html`<button class="btn" onClick=${() => decide('always')}>${tr('Always allow')}</button>`}
        <button class="btn primary" style="flex:1" onClick=${() => decide('approve')}>${tr('Approve')}</button>
      </div>
    </div>`;
}

function AgentChatCard({ call, d }) {
  const app = useApp();
  const ui = useUi();
  const other = app.getAgent(d.agentId);
  const running = call.status === 'running';
  const [open, setOpen] = useState(false);
  return html`
    <div class="agent-card">
      <div class="who">
        ${other && html`<${Avatar} shape=${other.shape} color=${other.color} size=${22} activity=${running ? botActivity(app, other, d.threadId) || 'thinking' : null} anim=${thinkingOf(other)} />`}
        <span>${other?.name || tr('Bot')}</span><span class="arrow">· ${running ? tr('replying…') : tr('replied')}</span>
        <button style="margin-left:auto;color:var(--muted);font-size:13px;font-weight:400" onClick=${() => d.threadId && ui.navigate(`#/chat/${d.threadId}`)}>${tr('View chat')}</button>
      </div>
      <div class="q">“${truncate(d.message, open ? 4000 : 140)}”</div>
      ${d.reply && html`<div class="a" onClick=${() => setOpen(!open)}><${Markdown} text=${open ? d.reply : truncate(d.reply, 400)} /></div>`}
      ${d.error && !d.reply && html`<div class="a" style="color:var(--red)">${d.error}</div>`}
    </div>`;
}

function DelegationCard({ d }) {
  const app = useApp();
  const other = app.getAgent(d.agentId);
  const task = app.tasks.get(d.taskId);
  const status = task?.status || 'running';
  return html`
    <div class="agent-card">
      <div class="who">${other && html`<${Avatar} shape=${other.shape} color=${other.color} size=${22} activity=${status === 'running' ? botActivity(app, other) || 'working' : null} anim=${thinkingOf(other)} />`}
        <span>${tr('Handed to {name}', { name: other?.name || tr('a bot') })}</span><span class="arrow">· ${status === 'running' ? tr('working…') : TASK_STATUS[status] ? tr(TASK_STATUS[status]) : status}</span></div>
      <div class="q">${truncate(d.task, 220)}</div>
    </div>`;
}

function TaskResultCard({ msg, agent }) {
  const [open, setOpen] = useState(false);
  const text = finalText(msg);
  return html`
    <div class="msg bot">
      <div class="agent-card" style="width:min(92%,620px)">
        <div class="who">${agent && html`<${Avatar} shape=${agent.shape} color=${agent.color} size=${22} />`}<span>${tr('Result from {name}', { name: agent?.name || tr('a bot') })}</span>
          <button style="margin-left:auto;color:var(--muted);font-size:13px;font-weight:400" onClick=${() => setOpen(!open)}>${open ? tr('Less') : tr('More')}</button></div>
        ${msg.delivery?.task && html`<div class="q">${truncate(msg.delivery.task, 160)}</div>`}
        <div class="a"><${Markdown} text=${open ? text : truncate(text, 360)} /></div>
      </div>
    </div>`;
}

function GeneratedImage({ fileId }) {
  const app = useApp();
  const ui = useUi();
  const { data: url } = useAsync(async () => {
    const f = await app.files.getById(fileId);
    return f?.blob ? URL.createObjectURL(f.blob) : null;
  }, [fileId]);
  useEffect(() => () => url && URL.revokeObjectURL(url), [url]);
  if (!url) return html`<div class="activity"><span class="spinner"></span><span class="lbl">${tr('Loading image…')}</span></div>`;
  return html`<img class="gen-image" src=${url} alt=${tr('Generated image')} onClick=${() => ui.openFile(fileId)} />`;
}

function ErrorCard({ msg }) {
  const app = useApp();
  const ui = useUi();
  // Credits used up: the bot pauses until they refill; Usage shows when. The
  // server's words say when too, which no dictionary has, so in another
  // language the card says it without the date.
  const credits = msg.errorKind === 'credits';
  return html`
    <div class="error-card" role="alert">
      ${credits && language() !== 'en' ? tr('Your AI credits for this month are used up. Your bots pause until they refill.') : msg.error ? tr(msg.error) : tr('Something went wrong.')}
      <div class="btn-row">
        ${credits && html`<button class="btn small primary" onClick=${() => ui.openSheet('settings', { page: 'usage' })}>${tr('See credits')}</button>`}
        <button class="btn small" onClick=${() => app.runtime.retry(msg.id)}><${Icon.retry} size="16" /> ${tr('Retry')}</button>
      </div>
    </div>`;
}

export function Sources({ items }) {
  return html`<div class="sources">
    ${items.slice(0, 12).map((s) => {
      let host = '';
      try {
        host = new URL(s.url).hostname.replace(/^www\./, '');
      } catch { host = s.url; }
      return html`<a class="source" href=${s.url} target="_blank" rel="noopener noreferrer" title=${s.title || s.url}>
        <img alt="" src=${`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`} onError=${(e) => { e.currentTarget.style.display = 'none'; }} />
        <span>${s.title && s.title !== s.url ? truncate(s.title, 40) : host}</span></a>`;
    })}
  </div>`;
}

function dedupeSources(list) {
  const seen = new Set();
  return list.filter((s) => s?.url && !seen.has(s.url) && seen.add(s.url));
}
