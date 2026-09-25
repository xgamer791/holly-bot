// Remote-control API: lets the Holly Bot app on your phone (or any browser)
// drive the bots that live on this computer. Methods mirror the app core.

const MASK = '••••';

export function maskKey(key) {
  if (!key) return '';
  return `${MASK}${String(key).slice(-4)}`;
}

export function isMasked(v) {
  return typeof v === 'string' && v.startsWith(MASK);
}

/** Settings as sent to clients: API keys/tokens masked. */
export function redactSettings(s) {
  const out = structuredClone(s);
  for (const p of Object.values(out.providers || {})) if (p?.apiKey) p.apiKey = maskKey(p.apiKey);
  for (const p of Object.values(out.services || {})) if (p?.apiKey) p.apiKey = maskKey(p.apiKey);
  for (const srv of out.mcpServers || []) {
    for (const k of Object.keys(srv.headers || {})) srv.headers[k] = maskKey(srv.headers[k]);
  }
  if (out.computer) out.computer = { url: '', token: '' };
  return out;
}

/** Merge a settings patch from a client without overwriting secrets with their masks. */
export function mergeSettingsPatch(current, patch) {
  const next = { ...patch };
  if (patch.providers) {
    next.providers = {};
    for (const [id, p] of Object.entries(patch.providers)) {
      const cur = current.providers?.[id] || {};
      next.providers[id] = { ...p, apiKey: isMasked(p?.apiKey) ? cur.apiKey : p?.apiKey };
    }
  }
  if (patch.services) {
    next.services = {};
    for (const [id, p] of Object.entries(patch.services)) {
      const cur = current.services?.[id] || {};
      next.services[id] = { ...p, apiKey: isMasked(p?.apiKey) ? cur.apiKey : p?.apiKey };
    }
  }
  if (patch.mcpServers) {
    next.mcpServers = patch.mcpServers.map((srv) => {
      const cur = (current.mcpServers || []).find((x) => x.id === srv.id);
      const headers = {};
      for (const [k, v] of Object.entries(srv.headers || {})) headers[k] = isMasked(v) ? cur?.headers?.[k] : v;
      return { ...srv, headers };
    });
  }
  delete next.computer; // the computer's own connection settings are not client-editable
  return next;
}

/** Messages without heavy base64 payloads (images are fetched by URL instead). */
export function sanitizeMessage(m) {
  if (!m) return m;
  let copy = null;
  const own = () => (copy ||= structuredClone(m));
  (m.parts || []).forEach((p, i) => {
    if (p.type === 'image' && p.data) {
      own().parts[i] = { ...p, data: undefined, src: `/api/msg-image/${m.id}/part/${i}` };
    }
  });
  (m.steps || []).forEach((s, si) => {
    if (s.raw) own().steps[si].raw = s.raw.provider === 'openai-chat' ? { provider: s.raw.provider } : null;
    (s.toolCalls || []).forEach((c, ci) => {
      (c.result?.images || []).forEach((img, ii) => {
        if (img.data) own().steps[si].toolCalls[ci].result.images[ii] = { mime: img.mime, src: `/api/msg-image/${m.id}/call/${c.id}/${ii}` };
      });
    });
  });
  return copy || m;
}

export function findImage(m, kind, a, b) {
  if (!m) return null;
  if (kind === 'part') return m.parts?.[Number(a)] || null;
  for (const s of m.steps || []) for (const c of s.toolCalls || []) if (c.id === a) return c.result?.images?.[Number(b)] || null;
  return null;
}

function plugins(app) {
  return app.plugins.list().map((p) => ({ ...p, tools: (p.tools || []).map((t) => ({ name: t.name, description: t.description })) }));
}

export function stateSnapshot(app, server) {
  return {
    server,
    settings: redactSettings(app.settings),
    providersReady: app.providers.readyProviders(),
    imageProvider: app.providers.imageProvider(),
    agents: [...app.agents.values()],
    threads: [...app.threads.values()],
    tasks: [...app.tasks.values()],
    runs: app.runtime.activeRuns().map(({ controller, ...r }) => r),
    computer: app.computer.info,
    plugins: plugins(app),
    timeZone: app.timeZone(),
  };
}

/**
 * RPC methods callable by clients: name → (app, args, ctx) => result.
 * Anything returning messages goes through sanitizeMessage.
 */
export const RPC = {
  'agents.create': (app, [data]) => app.createAgent(data),
  'agents.update': (app, [id, patch]) => app.updateAgent(id, patch),
  'agents.delete': (app, [id]) => app.deleteAgent(id),

  'threads.createGroup': (app, [data]) => app.createGroup(data),
  'threads.update': (app, [id, patch]) => app.updateThread(id, patch),
  'threads.delete': (app, [id]) => app.deleteThread(id),
  'threads.clear': (app, [id]) => app.clearThread(id),
  'threads.markRead': (app, [id]) => app.markRead(id),
  'threads.view': (app, [threadId], ctx) => app.setViewing(threadId || null, ctx.clientId),
  'threads.ensureDm': (app, [agentId]) => app.ensureDmThread(agentId),

  'messages.list': async (app, [threadId]) => (await app.loadMessages(threadId)).map(sanitizeMessage),
  'messages.get': async (app, [id]) => sanitizeMessage(await app.getMessage(id)),
  'messages.delete': (app, [id]) => app.deleteMessage(id),

  'runtime.send': (app, [threadId, payload]) => { app.runtime.send(threadId, payload).catch((e) => console.warn(e)); return true; },
  'runtime.answer': (app, [m, c, a]) => { app.runtime.answer(m, c, a).catch((e) => console.warn(e)); return true; },
  'runtime.dismiss': (app, [m, c]) => app.runtime.dismiss(m, c),
  'runtime.approve': (app, [m, c, d]) => { app.runtime.approve(m, c, d).catch((e) => console.warn(e)); return true; },
  'runtime.retry': (app, [m]) => { app.runtime.retry(m).catch((e) => console.warn(e)); return true; },
  'runtime.regenerate': (app, [m]) => { app.runtime.regenerate(m).catch((e) => console.warn(e)); return true; },
  'runtime.stop': (app, [threadId]) => app.runtime.stop(threadId),
  'runtime.stopAll': (app) => app.runtime.stopAll(),
  'runtime.runRoutine': async (app, [id]) => {
    const r = await app.routines.get(id);
    if (r) app.runtime.runRoutine(r).catch((e) => console.warn(e));
    return !!r;
  },

  'memory.list': (app, [owner, opts]) => app.memory.list(owner, opts).then(stripEmb),
  'memory.search': async (app, [owner, query, opts]) => (await app.memory.search(owner, query, opts)).map((r) => ({ ...r, memory: stripEmb1(r.memory) })),
  'memory.count': (app, [owner]) => app.memory.count(owner),
  'memory.get': async (app, [id]) => stripEmb1(await app.memory.get(id)),
  'memory.add': async (app, [owner, data]) => {
    const r = await app.memory.add(owner, data);
    return { ...r, memory: stripEmb1(r.memory) };
  },
  'memory.update': async (app, [id, patch]) => stripEmb1(await app.memory.update(id, patch)),
  'memory.remove': (app, [id]) => app.memory.remove(id),
  'memory.reindex': (app, [agentId]) => app.memory.reindex(agentId),
  'memory.reflect': (app, [agentId]) => app.reflectNow(agentId),
  'user.learnFromEmail': (app) => app.learnFromEmail(),

  'files.list': (app, [agentId, prefix]) => app.files.list(agentId, prefix),
  'files.meta': async (app, [id]) => {
    const f = await app.files.getById(id);
    if (!f) return null;
    const { blob, text, ...meta } = f;
    return { ...meta, hasText: text != null };
  },
  'files.readText': (app, [agentId, path]) => app.files.readText(agentId, path),
  'files.write': async (app, [agentId, path, body]) => {
    const content = body.base64 != null ? new Blob([Buffer.from(body.base64, 'base64')], { type: body.mime || 'application/octet-stream' }) : body.text;
    const f = await app.files.write(agentId, path, content, { mime: body.mime, source: body.source || 'user' });
    const { blob, text, ...meta } = f;
    return meta;
  },
  'files.remove': (app, [agentId, path]) => app.files.remove(agentId, path),

  'routines.list': (app, [agentId]) => app.routines.list(agentId),
  'routines.create': (app, [data]) => app.routines.create(data),
  'routines.update': (app, [id, patch]) => app.routines.update(id, patch),
  'routines.remove': (app, [id]) => app.routines.remove(id),
  'routines.setAllEnabled': (app, [enabled]) => app.routines.setAllEnabled(enabled),

  'settings.save': (app, [patch]) => app.saveSettings(mergeSettingsPatch(app.settings, patch)),
  'providers.test': async (app, [id]) => (await app.providers.test(id)).map((m) => ({ id: m.id, name: m.name })),
  'providers.balance': (app, [id]) => app.providers.balance(id),
  'plugins.refresh': async (app) => {
    await app.computer.mcp?.reload?.();
    await app.plugins.refresh();
    return plugins(app);
  },

  'activity.load': (app, [agentId, limit]) => app.loadActivity(agentId, limit),
  'data.export': (app, [opts]) => app.exportData(opts),
  'data.import': (app, [data]) => app.importData(data),
  'data.reset': (app) => app.resetAll(),
};

function stripEmb1(m) {
  if (!m) return m;
  const { emb, ...rest } = m;
  return rest;
}

function stripEmb(list) {
  return list.map(stripEmb1);
}
