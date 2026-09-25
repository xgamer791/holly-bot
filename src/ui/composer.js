import { html, useState, useRef, useEffect } from '../../vendor/preact.js';
import { useApp, useUi, useTopics, haptic } from './hooks.js';
import { Icon } from './icons.js';
import { Popover } from './components.js';
import { Avatar } from './avatar.js';
import { listen, sttSupported } from './speech.js';
import { formatBytes } from '../core/util.js';

const MAX_IMAGE_EDGE = 1600;

export async function imageToPart(file) {
  const small = file.size < 350 * 1024 && /^image\/(png|jpeg|webp|gif)$/.test(file.type);
  if (small) return { type: 'image', mime: file.type, data: await fileB64(file), name: file.name };
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return { type: 'image', mime: file.type || 'image/jpeg', data: await fileB64(file), name: file.name };
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
  return { type: 'image', mime: 'image/jpeg', data: await fileB64(blob), name: file.name.replace(/\.\w+$/, '.jpg') };
}

async function fileB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function Composer({ thread, agents, onVoice }) {
  const app = useApp();
  const ui = useUi();
  useTopics(['runs', 'threads', 'agents', `thread:${thread.id}`]);
  const [text, setText] = useState(() => app.drafts?.get(thread.id) || '');
  const [atts, setAtts] = useState([]);
  const [menu, setMenu] = useState(null);
  const [dictating, setDictating] = useState(null);
  const [mention, setMention] = useState(null);
  const taRef = useRef(null);
  const plusRef = useRef(null);
  const imgInput = useRef(null);
  const camInput = useRef(null);
  const fileInput = useRef(null);
  const busy = app.runtime.isThreadBusy(thread.id);
  const isGroup = thread.kind === 'group';
  const primary = agents[0];

  // The textarea isn't controlled: this re-renders all the time while a bot
  // works, and writing the text back into the box mid-typing upsets iOS
  // dictation and predictive text (their gray text ends up over the
  // placeholder). What the app itself changes goes in through put().
  const put = (v) => {
    if (taRef.current && taRef.current.value !== v) taRef.current.value = v;
    setText(v);
  };
  useEffect(() => {
    app.drafts ||= new Map();
    app.drafts.set(thread.id, text);
  }, [text]);
  useEffect(() => {
    put(app.drafts?.get(thread.id) || '');
    setAtts([]);
  }, [thread.id]);
  useEffect(() => autosize(taRef.current), [text]);
  useEffect(() => () => dictating?.stop(), [dictating]);

  const send = async () => {
    const body = text.trim();
    if (!body && !atts.length) return;
    haptic(app);
    put('');
    setAtts([]);
    setMention(null);
    app.drafts?.set(thread.id, '');
    try {
      await app.runtime.send(thread.id, { text: body, attachments: atts });
    } catch (err) {
      ui.toast(err.message, { error: true });
    }
  };

  // The chat is free at once (Runtime.stop); only a computer that can't be
  // reached keeps it busy, and says so.
  const stop = async () => {
    haptic(app);
    try {
      await app.runtime.stop(thread.id);
    } catch (err) {
      ui.toast(err.message, { error: true });
    }
  };

  const onFiles = async (files, kind) => {
    for (const file of files) {
      try {
        if (kind === 'image' || file.type.startsWith('image/')) {
          const part = await imageToPartSafe(file);
          setAtts((a) => [...a, { ...part, preview: URL.createObjectURL(file) }]);
        } else {
          const owner = primary?.id;
          if (!owner) continue;
          const f = await app.files.write(owner, `uploads/${file.name}`, file, { mime: file.type, source: 'user' });
          setAtts((a) => [...a, { type: 'file', fileId: f.id, name: file.name, mime: f.mime, size: f.size }]);
        }
      } catch (err) {
        ui.toast(`Couldn't attach ${file.name}: ${err.message}`, { error: true });
      }
    }
  };

  const toggleDictation = () => {
    if (dictating) {
      dictating.stop();
      setDictating(null);
      return;
    }
    if (!sttSupported()) {
      ui.toast('Dictation is not supported in this browser. Try the keyboard mic.', { error: true });
      return;
    }
    const base = text ? `${text.trimEnd()} ` : '';
    const rec = listen({
      onText: (fin, interim) => put(base + fin + interim),
      onEnd: () => setDictating(null),
      onError: (err) => {
        ui.toast(err.message, { error: true });
        setDictating(null);
      },
    });
    setDictating(rec);
    haptic(app);
  };

  const onInput = (e) => {
    const v = e.currentTarget.value;
    setText(v);
    if (isGroup) {
      const m = v.slice(0, e.currentTarget.selectionStart).match(/@([\p{L}\p{N}_.-]*)$/u);
      setMention(m ? m[1].toLowerCase() : null);
    }
  };

  const insertMention = (a) => {
    put((taRef.current?.value ?? text).replace(/@([\p{L}\p{N}_.-]*)$/u, `@${a.name.replace(/\s+/g, '')} `));
    setMention(null);
    taRef.current?.focus();
  };

  const onKeyDown = (e) => {
    const coarse = matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // Web search is the bots' own setting (Tools in a bot's profile): the
  // search button turns it on or off for this chat's bot (or bots).
  const webOn = agents.length > 0 && agents.every((a) => a.tools?.web !== false);
  const toggleWeb = async () => {
    if (!agents.length) return;
    haptic(app);
    const on = !webOn;
    try {
      await Promise.all(agents.map((a) => app.updateAgent(a.id, { tools: { ...(a.tools || {}), web: on } })));
      ui.toast(on ? 'Web search on' : 'Web search off');
    } catch (err) {
      ui.toast(err.message, { error: true });
    }
  };
  // The computer in the pill is grayed out and does nothing: the button at the
  // top right of the chat shows the computer's connection and opens it.
  const ws = (app.getThread(thread.id) || thread).workspace || null;

  const hasContent = text.trim() || atts.length;
  const placeholder = 'Ask anything…';
  const label = isGroup ? `Message ${thread.title || 'the group'}` : `Ask ${primary?.name || 'your bot'}`;
  const hint = isGroup && thread.mode === 'mention' ? 'Ask anything — @mention who should reply' : null;
  const mentionOptions = mention != null ? agents.filter((a) => a.name.toLowerCase().replace(/\s+/g, '').startsWith(mention)) : [];

  return html`
    ${atts.length > 0 && html`<div class="pending-atts">
      ${atts.map((a, i) => html`<div class="pending-att" key=${i}>
        ${a.type === 'image' ? html`<img src=${a.preview || `data:${a.mime};base64,${a.data}`} alt=${a.name} />` : html`<div class="file"><${Icon.file} size="18" /><span>${a.name}<br /><small>${formatBytes(a.size)}</small></span></div>`}
        <button class="rm" aria-label="Remove" onClick=${() => setAtts(atts.filter((_, j) => j !== i))}><${Icon.x} /></button>
      </div>`)}
    </div>`}
    <div class="composer">
      ${mentionOptions.length > 0 && html`<div class="mention-list">${mentionOptions.map((a) => html`
        <button key=${a.id} onClick=${() => insertMention(a)}><${Avatar} shape=${a.shape} color=${a.color} size=${24} /> ${a.name}</button>`)}</div>`}
      <div class="pbar">
        <textarea ref=${taRef} class="pbar-input" rows="1" placeholder=${hint || placeholder} aria-label=${label}
          onInput=${onInput} onKeyDown=${onKeyDown}
          onPaste=${(e) => {
            const files = [...(e.clipboardData?.files || [])];
            if (files.length) {
              e.preventDefault();
              onFiles(files);
            }
          }}></textarea>
        <div class="pbar-row">
          <button ref=${plusRef} class="pbar-btn" aria-label="Add attachment" onClick=${() => setMenu(plusRef.current)}><${Icon.plus} /></button>
          <div class="pbar-seg">
            <button class=${`pbar-seg-btn ${webOn ? 'on' : ''}`} aria-pressed=${webOn} aria-label=${webOn ? 'Web search on' : 'Web search off'} onClick=${toggleWeb}><${Icon.search} /></button>
            <button class="pbar-seg-btn" disabled aria-hidden="true" tabindex="-1"><${Icon.botScreen} /></button>
          </div>
          <button class=${`pbar-pill ${ws ? 'set' : ''}`} aria-label=${ws ? `Workspace: ${workspaceLabel(ws)}` : 'Workspace'} onClick=${() => ui.openSheet('workspace', { threadId: thread.id })}>
            ${ws?.kind === 'github' && html`<${Icon.github} size="15" />`}
            ${ws?.kind === 'server' && html`<${Icon.server} size="15" />`}
            <span>${workspaceLabel(ws)}</span>
          </button>
          <span class="pbar-gap"></span>
          <button class=${`pbar-btn ${dictating ? 'recording' : ''}`} aria-label=${dictating ? 'Stop dictation' : 'Dictate'} onClick=${toggleDictation}><${Icon.mic} /></button>
          ${hasContent
            ? html`<button class="pbar-go" aria-label="Send" onClick=${send}><${Icon.up} /></button>`
            : busy
              ? html`<button class="pbar-go stop" aria-label="Stop" onClick=${stop}><span></span></button>`
              : html`<button class="pbar-go" aria-label="Voice mode" onClick=${onVoice}><${Icon.wave} /></button>`}
        </div>
      </div>
    </div>
    ${menu && html`<${Popover} anchor=${menu} from="bottom" onClose=${() => setMenu(null)} items=${[
      { label: 'Attach Image', icon: Icon.image, onClick: () => imgInput.current.click() },
      { label: 'Take Photo', icon: Icon.camera, onClick: () => camInput.current.click() },
      { label: 'Choose File', icon: Icon.folder, onClick: () => fileInput.current.click() },
    ]} />`}
    <input ref=${imgInput} type="file" accept="image/*" multiple hidden onChange=${(e) => { onFiles([...e.currentTarget.files], 'image'); e.currentTarget.value = ''; }} />
    <input ref=${camInput} type="file" accept="image/*" capture="environment" hidden onChange=${(e) => { onFiles([...e.currentTarget.files], 'image'); e.currentTarget.value = ''; }} />
    <input ref=${fileInput} type="file" multiple hidden onChange=${(e) => { onFiles([...e.currentTarget.files]); e.currentTarget.value = ''; }} />`;
}

/** The Workspace button's words: the chat's repository or app (and how many
 * more), its server, or the word itself when it has none. */
export function workspaceLabel(ws) {
  if (ws?.kind === 'github' && ws.repos?.length) {
    const first = ws.repos[0].split('/').pop();
    return ws.repos.length > 1 ? `${first} +${ws.repos.length - 1}` : first;
  }
  if (ws?.kind === 'server') {
    const apps = ws.apps || [];
    return apps.length ? `${apps[0].name}${apps.length > 1 ? ` +${apps.length - 1}` : ''}` : ws.name || 'Server';
  }
  return 'Workspace';
}

async function imageToPartSafe(file) {
  try {
    return await imageToPart(file);
  } catch {
    return { type: 'image', mime: file.type || 'image/jpeg', data: await fileB64(file), name: file.name };
  }
}

function autosize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(160, el.scrollHeight)}px`;
}
