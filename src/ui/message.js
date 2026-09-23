import { html, useState, useEffect } from '../../vendor/preact.js';
import { useApp, useUi, useAsync, haptic } from './hooks.js';
import { Avatar } from './avatar.js';
import { Icon, fileIcon } from './icons.js';
import { Markdown } from './markdown.js';
import { copyText } from './components.js';
import { formatBytes, truncate } from '../core/util.js';
import { finalText } from '../core/runtime.js';
import { speak } from './speech.js';

const LETTERS = 'ABCDEFGH';

export function MessageView({ msg, thread, showAuthor, isLast }) {
  if (msg.hidden || msg.quiet) return null;
  if (msg.authorType === 'system') return html`<${SystemNotice} msg=${msg} />`;
  if (msg.authorType === 'user') return html`<${UserMessage} msg=${msg} />`;
  return html`<${BotMessage} msg=${msg} thread=${thread} showAuthor=${showAuthor} isLast=${isLast} />`;
}

function SystemNotice({ msg }) {
  const text = (msg.parts || []).map((p) => p.text).join(' ');
  if (msg.routineId) {
    const title = text.match(/Routine “([^”]+)”/)?.[1] || 'Routine';
    return html`<div class="notice routine"><${Icon.clock} size="14" class="inline" /> Routine: ${title}</div>`;
  }
  return html`<div class="notice">${text}</div>`;
}

function UserMessage({ msg }) {
  const app = useApp();
  const text = (msg.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const images = (msg.parts || []).filter((p) => p.type === 'image');
  const files = (msg.parts || []).filter((p) => p.type === 'file');
  return html`
    <div class="msg user">
      ${(images.length > 0 || files.length > 0) && html`<div class="att-row">
        ${images.map((p, i) => html`<img key=${i} class="att-img" alt=${p.name || 'image'} src=${imgSrc(app, p)} />`)}
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
  const nothingYet = streaming && !msg.steps.some((s) => s.text || s.thinking || s.toolCalls?.length || s.serverTools?.length);

  return html`
    <div class="msg bot">
      ${showAuthor && agent && html`<div class="author"><${Avatar} shape=${agent.shape} color=${agent.color} size=${20} /> ${agent.name}</div>`}
      <div class="steps">
        ${msg.steps.map((step, i) => html`<${StepView} key=${step.id || i} step=${step} msg=${msg} streaming=${streaming && step === lastStep} />`)}
        ${nothingYet && html`<${Typing} agent=${agent} />`}
        ${citations.length > 0 && html`<${Sources} items=${citations} />`}
        ${msg.status === 'error' && html`<${ErrorCard} msg=${msg} />`}
        ${msg.status === 'stopped' && !text && html`<div class="notice" style="align-self:flex-start">Stopped.</div>`}
        ${msg.memoryOps?.length > 0 && html`<button class="memory-note" onClick=${() => ui.openSheet('memory', { agentId: msg.authorId })}>
          <${Icon.brain} /> ${memorySummary(msg.memoryOps)}</button>`}
      </div>
      ${!streaming && text && msg.status !== 'error' && html`<div class="msg-actions">
        <button aria-label="Copy" onClick=${() => copyText(text).then(() => ui.toast('Copied'))}><${Icon.copy} /></button>
        <button aria-label="Read aloud" onClick=${() => speak(text, app)}><${Icon.wave} /></button>
        ${isLast && thread?.kind !== 'agents' && html`<button aria-label="Regenerate" onClick=${() => ui.regenerate(msg)}><${Icon.retry} /></button>`}
      </div>`}
    </div>`;
}

function memorySummary(ops) {
  const add = ops.filter((o) => o.op === 'add').length;
  const upd = ops.filter((o) => o.op === 'update').length;
  const del = ops.filter((o) => o.op === 'delete').length;
  const parts = [];
  if (add) parts.push(`Remembered ${add} ${add === 1 ? 'thing' : 'things'}`);
  if (upd) parts.push(`updated ${upd}`);
  if (del) parts.push(`forgot ${del}`);
  return parts.join(', ') || 'Memory updated';
}

function StepView({ step, msg, streaming }) {
  const [showThinking, setShowThinking] = useState(false);
  const thinking = (step.thinking || '').trim();
  return html`
    ${thinking && html`
      <button class="activity thinking" onClick=${() => setShowThinking(!showThinking)}>
        <span class="ic"><${Icon.sparkle} /></span><span class=${`lbl ${streaming && !step.text ? 'running' : ''}`}>${streaming && !step.text && !step.toolCalls?.length ? 'Thinking…' : 'Thoughts'}</span>
        <${Icon.down} size="14" />
      </button>
      ${showThinking && html`<div class="thinking-body">${thinking}</div>`}`}
    ${(step.serverTools || []).map((st) => html`<${ServerToolView} key=${st.id} st=${st} />`)}
    ${step.text && html`<div class="bubble"><${Markdown} text=${step.text} streaming=${streaming} /></div>`}
    ${(step.toolCalls || []).map((c) => html`<${ToolCallView} key=${c.id} call=${c} msg=${msg} />`)}
    ${(step.notices || []).map((n, i) => html`<div key=${i} class="notice" style="align-self:flex-start;text-align:left">${n}</div>`)}`;
}

function ServerToolView({ st }) {
  const [open, setOpen] = useState(false);
  const name = st.name === 'x_search' ? 'Searched X' : st.name === 'web_fetch' ? 'Read' : st.name === 'code_interpreter' || st.name === 'code_execution' ? 'Ran code' : 'Searched the web';
  const q = st.input?.query || st.input?.url || '';
  const running = st.status === 'running';
  return html`
    <button class=${`activity ${running ? 'running' : ''} ${st.status === 'error' ? 'error' : ''}`} onClick=${() => setOpen(!open)}>
      <span class="ic">${running ? html`<span class="spinner"></span>` : html`<${Icon.globe} />`}</span>
      <span class="lbl">${name}${q ? ` for “${truncate(q, 60)}”` : ''}${st.sources?.length ? ` · ${st.sources.length} results` : ''}</span>
    </button>
    ${open && st.sources?.length > 0 && html`<${Sources} items=${st.sources} />`}`;
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
    const label = d.op === 'delete' ? 'Forgot' : d.op === 'core' ? 'Updated core memory' : d.op === 'update' ? 'Updated memory' : d.shared ? 'Saved to team memory' : 'Saved to memory';
    return html`<button class="memory-note" onClick=${() => ui.openSheet('memory', { agentId: msg.authorId })}><${Icon.brain} /> ${label}${d.op !== 'core' ? `: ${truncate(d.text, 90)}` : ''}</button>`;
  }
  if (d?.kind === 'routine') {
    return html`<div class="agent-card"><div class="who"><${Icon.clock} size="16" /> Routine scheduled</div>
      <div class="a"><b>${d.title}</b> — ${d.schedule}</div>
      <div class="q" style="margin:4px 0 0">Next run ${d.nextRunAt ? new Date(d.nextRunAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—'}</div></div>`;
  }
  if (d?.kind === 'delegation') return html`<${DelegationCard} d=${d} />`;
  return html`<${ActivityLine} call=${call} />`;
}

function iconFor(name) {
  if (/^(recall|remember|forget|update_memory|core_memory|search_history)$/.test(name)) return Icon.brain;
  if (/web_search|fetch_url/.test(name)) return Icon.globe;
  if (/run_python|run_javascript/.test(name)) return Icon.code;
  if (/shell|computer_files/.test(name)) return Icon.terminal;
  if (/browser|screenshot/.test(name)) return Icon.monitor;
  if (/file/.test(name)) return Icon.file;
  if (/agent|delegate/.test(name)) return Icon.chat;
  if (/routine/.test(name)) return Icon.clock;
  if (/image/.test(name)) return Icon.image;
  if (/^mcp_/.test(name)) return Icon.plug;
  if (/skill/.test(name)) return Icon.sparkle;
  return Icon.bot;
}

function ActivityLine({ call }) {
  const app = useApp();
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const Ic = iconFor(call.name);
  const running = call.status === 'running' || call.status === 'preparing';
  const error = call.status === 'error' || call.result?.isError;
  const d = call.display || {};
  const label = call.label || prettyName(call.name);
  const images = call.result?.images || [];
  const showImagesInline = d.kind === 'code' || d.kind === 'screenshot' || d.kind === 'browser';
  const decided = call.approval && call.approval.status !== 'pending' ? (call.approval.status === 'denied' ? ' · denied' : ' · approved') : '';
  return html`
    <button class=${`activity ${running ? 'running' : ''} ${error ? 'error' : ''}`} onClick=${() => setOpen(!open)} aria-expanded=${open}>
      <span class="ic">${running ? html`<span class="spinner"></span>` : html`<${Ic} />`}</span>
      <span class="lbl">${label}${decided}${running && call.progress ? ` — ${call.progress}` : ''}</span>
    </button>
    ${showImagesInline && images.map((img, i) => html`<img key=${i} class="chart-img" style="max-width:min(88%,480px)" src=${imgSrc(app, img)} alt="Tool output image" />`)}
    ${d.kind === 'file_saved' && !open && html`<button class="activity" style="padding-left:32px" onClick=${() => ui.openFile(d.fileId)}><span class="lbl" style="color:var(--blue)">Open ${d.path}</span></button>`}
    ${d.kind === 'search' && d.results?.length > 0 && open && html`<${Sources} items=${d.results} />`}
    ${open && html`<div class="activity-detail">${detailFor(call)}</div>`}`;
}

function detailFor(call) {
  const d = call.display || {};
  if (d.kind === 'terminal') {
    return html`<div class="terminal"><span class="cmd">$ ${d.command}</span>\n${d.stdout}${d.stderr ? html`<span class="err">\n${d.stderr}</span>` : ''}\n<span class="cmd">[exit ${d.code}]</span></div>`;
  }
  if (d.kind === 'code') {
    return html`
      <div class="k">${d.language}</div><pre>${d.code}</pre>
      ${d.stdout && html`<div class="k">Output</div><pre>${d.stdout}</pre>`}
      ${d.result && html`<div class="k">Result</div><pre>${d.result}</pre>`}
      ${(d.error || d.stderr) && html`<div class="k">Errors</div><pre style="color:var(--red)">${d.error || d.stderr}</pre>`}
      ${d.saved?.length > 0 && html`<div class="k">Files saved</div><pre>${d.saved.join('\n')}</pre>`}`;
  }
  const args = call.args && Object.keys(call.args).length ? JSON.stringify(call.args, null, 2) : '';
  return html`
    ${args && html`<div class="k">Input</div><pre>${truncate(args, 4000)}</pre>`}
    <div class="k">${call.result?.isError ? 'Error' : 'Result'}</div>
    <pre>${truncate(String(call.result?.content ?? (call.status === 'running' ? 'Running…' : '')), 6000)}</pre>`;
}

function prettyName(name) {
  if (name.startsWith('mcp_')) return name.slice(4).replace(/_/g, ' ');
  return name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
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
      return html`<div class="card"><div class="card-title" style="margin-right:0">${pending.question}</div><div class="card-sub" style="margin-bottom:0">Dismissed — answer in the chat below whenever you're ready.</div></div>`;
    }
    return null;
  }
  return html`
    <div class="card" role="group" aria-label=${pending.question}>
      <div class="card-title">${pending.question}</div>
      ${pending.subtitle && html`<div class="card-sub">${pending.subtitle}</div>`}
      ${open && html`<button class="card-x" aria-label="Dismiss" onClick=${() => app.runtime.dismiss(msg.id, call.id)}><${Icon.x} /></button>`}
      ${open ? html`
        <div class="options">
          ${options.map((opt, i) => html`
            <button key=${opt} class=${`option ${multi.includes(opt) ? 'multi-on' : ''}`} onClick=${() => pick(opt)}>
              <span class="letter">${LETTERS[i] || i + 1}</span><span>${opt}</span>
              ${multi.includes(opt) && html`<${Icon.check} class="ok" />`}
            </button>`)}
        </div>
        ${pending.multiple && html`<button class="btn primary block" style="margin-top:12px" disabled=${!multi.length} onClick=${() => app.runtime.answer(msg.id, call.id, multi)}>Done</button>`}
        <div class="card-foot">Or answer in the chat below</div>`
      : html`
        <div class="options">
          <div class="option picked">
            <span>${call.answeredInChat ? 'Answered in chat' : call.answer || 'Answered'}</span>
            <${Icon.check} class="ok" />
          </div>
        </div>`}
    </div>`;
}

function ApprovalCard({ call, msg }) {
  const app = useApp();
  const agent = app.getAgent(msg.authorId);
  const decide = (d) => {
    haptic(app, 'heavy');
    app.runtime.approve(msg.id, call.id, d);
  };
  return html`
    <div class="card approval" role="group" aria-label="Permission required">
      <div class="head"><${Icon.shield} /> Permission required</div>
      <div class="card-sub" style="margin-bottom:10px">${agent?.name || 'Your bot'} wants to ${call.label ? call.label.charAt(0).toLowerCase() + call.label.slice(1) : call.name}:</div>
      <div class="cmd">${call.approval.summary}</div>
      <div class="btn-row">
        <button class="btn" onClick=${() => decide('deny')}>Deny</button>
        <button class="btn" onClick=${() => decide('always')}>Always allow</button>
        <button class="btn primary" style="flex:1" onClick=${() => decide('approve')}>Approve</button>
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
        ${other && html`<${Avatar} shape=${other.shape} color=${other.color} size=${22} working=${running} />`}
        <span>${other?.name || 'Bot'}</span><span class="arrow">· ${running ? 'replying…' : 'replied'}</span>
        <button style="margin-left:auto;color:var(--muted);font-size:13px;font-weight:400" onClick=${() => d.threadId && ui.navigate(`#/chat/${d.threadId}`)}>View chat</button>
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
      <div class="who">${other && html`<${Avatar} shape=${other.shape} color=${other.color} size=${22} working=${status === 'running'} />`}
        <span>Handed to ${other?.name || 'a bot'}</span><span class="arrow">· ${status === 'running' ? 'working…' : status}</span></div>
      <div class="q">${truncate(d.task, 220)}</div>
    </div>`;
}

function TaskResultCard({ msg, agent }) {
  const [open, setOpen] = useState(false);
  const text = finalText(msg);
  return html`
    <div class="msg bot">
      <div class="agent-card" style="width:min(92%,620px)">
        <div class="who">${agent && html`<${Avatar} shape=${agent.shape} color=${agent.color} size=${22} />`}<span>Result from ${agent?.name || 'a bot'}</span>
          <button style="margin-left:auto;color:var(--muted);font-size:13px;font-weight:400" onClick=${() => setOpen(!open)}>${open ? 'Less' : 'More'}</button></div>
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
  if (!url) return html`<div class="activity"><span class="spinner"></span><span class="lbl">Loading image…</span></div>`;
  return html`<img class="gen-image" src=${url} alt="Generated image" onClick=${() => ui.openFile(fileId)} />`;
}

function ErrorCard({ msg }) {
  const app = useApp();
  const ui = useUi();
  const keyIssue = msg.errorKind === 'no_key' || msg.errorKind === 'auth' || /API key/i.test(msg.error || '');
  return html`
    <div class="error-card" role="alert">
      ${msg.error || 'Something went wrong.'}
      <div class="btn-row">
        ${keyIssue && html`<button class="btn small primary" onClick=${() => ui.openSheet('settings', { page: 'keys' })}>API keys</button>`}
        <button class="btn small" onClick=${() => app.runtime.retry(msg.id)}><${Icon.retry} size="16" /> Retry</button>
      </div>
    </div>`;
}

function Typing({ agent }) {
  return html`<div class="typing">${agent && html`<${Avatar} shape=${agent.shape} color=${agent.color} size=${34} working />`}</div>`;
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
