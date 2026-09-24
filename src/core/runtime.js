import { uid, now, truncate, estimateTokens, errorMessage, isAbort, normalizeName } from './util.js';
import { toolsForAgent, validateArgs, coerceArgs } from './tools/index.js';
import { CONNECTOR_READS } from './tools/connector-tools.js';
import { buildSystemPrompt, buildMessageContext } from './prompts.js';
import { extractAndApply, summarizeHistory, synthesizeProfile, reflect } from './memory/extract.js';
import { MAX_TOOL_STEPS } from './constants.js';
import { contextWindow, supportsVision } from './providers/index.js';
import { extractJson } from './util.js';

// The agent runtime: builds each bot's context, streams model output, runs
// tools, pauses for approvals / questions, lets bots talk to each other, and
// runs background memory work. Everything is persisted as it happens, so a
// paused turn can resume after a reload.

const PARALLEL_SAFE = new Set(['recall', 'search_history', 'web_search', 'fetch_url', 'message_agent', 'list_files', 'read_file', 'list_agents', ...CONNECTOR_READS]);
const GROUP_MAX_HOPS = 8;

export class Runtime {
  constructor(app) {
    this.app = app;
    this.runs = new Map(); // threadId -> { controller, agentId, messageId }
    this.queues = new Map(); // threadId -> Promise chain
    this.bgQueues = new Map(); // agentId -> Promise chain (memory jobs)
  }

  // ----- status ---------------------------------------------------------

  isThreadBusy(threadId) {
    return this.runs.has(threadId);
  }

  isAgentBusy(agentId) {
    for (const r of this.runs.values()) if (r.agentId === agentId) return true;
    return false;
  }

  /** What a reply is doing, for the bot's face (src/ui/avatar.js): 'thinking'
   * while its model thinks or writes, 'working' while tools run. */
  setPhase(threadId, phase) {
    const run = this.runs.get(threadId);
    if (!run || run.phase === phase) return;
    run.phase = phase;
    this.app.emitRuns();
  }

  activeRuns() {
    return [...this.runs.entries()].map(([threadId, r]) => ({ threadId, ...r }));
  }

  stop(threadId) {
    const r = this.runs.get(threadId);
    if (r) r.controller.abort(new DOMException('Stopped by user', 'AbortError'));
  }

  stopAll() {
    for (const r of this.runs.values()) r.controller.abort(new DOMException('Stopped', 'AbortError'));
  }

  /** Serialize work per thread so turns never interleave. */
  enqueue(threadId, fn) {
    const prev = this.queues.get(threadId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(threadId, next.finally(() => {
      if (this.queues.get(threadId) === next) this.queues.delete(threadId);
    }));
    return next;
  }

  // ----- user entry points ------------------------------------------------

  /** The user sends a message into a thread (DM or group). */
  async send(threadId, { text = '', attachments = [] }) {
    const app = this.app;
    const thread = app.getThread(threadId);
    if (!thread) throw new Error('Thread not found');
    const parts = [];
    if (text.trim()) parts.push({ type: 'text', text: text.trim() });
    for (const { preview, ...a } of attachments) parts.push(a);
    if (!parts.length) return null;

    // A bot is waiting on a question/approval in this thread: the typed text answers it.
    let waiting = await this.findWaiting(threadId);
    if (waiting?.call.local) {
      // The greeting card: typing in chat simply answers it with a normal message.
      await this.closeLocalQuestion(waiting.message, waiting.call, text.trim(), { inChat: true });
      waiting = null;
    }
    const userMsg = await app.addMessage({
      threadId, authorType: 'user', authorId: 'user', parts,
      ...(waiting ? { answerTo: { messageId: waiting.message.id, callId: waiting.call.id } } : {}),
    });
    if (waiting) {
      const answer = text.trim() || '(sent an attachment)';
      if (waiting.call.pending?.kind === 'question') await this.recordAnswer(waiting.message, waiting.call, answer, { typed: true });
      else await this.recordApproval(waiting.message, waiting.call, 'deny', { note: answer });
      return this.enqueue(threadId, () => this.resume(waiting.message.id));
    }
    if (thread.kind === 'group') return this.enqueue(threadId, () => this.runGroup(thread, userMsg));
    const agent = app.getAgent(thread.agentIds[0]);
    if (!agent) throw new Error('This bot no longer exists');
    return this.enqueue(threadId, () => this.runTurn({ agent, threadId }));
  }

  /** User tapped an option on a question card (or submitted several). */
  async answer(messageId, callId, answer) {
    const msg = await this.app.getMessage(messageId);
    const call = findCall(msg, callId);
    if (!call || call.result) return;
    const value = Array.isArray(answer) ? answer.join(', ') : answer;
    if (call.local) {
      await this.closeLocalQuestion(msg, call, value);
      const agent = this.app.getAgent(msg.authorId);
      if (agent && callId.startsWith('onboard_')) await this.app.updateAgent(agent.id, { focus: value });
      await this.app.addMessage({ threadId: msg.threadId, authorType: 'user', authorId: 'user', parts: [{ type: 'text', text: value }], quiet: true });
      if (!agent) return;
      return this.enqueue(msg.threadId, () => this.runTurn({ agent, threadId: msg.threadId }));
    }
    await this.recordAnswer(msg, call, Array.isArray(answer) ? answer.join(', ') : answer);
    return this.enqueue(msg.threadId, () => this.resume(messageId));
  }

  /** User dismissed a question card without answering. */
  async dismiss(messageId, callId) {
    const msg = await this.app.getMessage(messageId);
    const call = findCall(msg, callId);
    if (!call || call.result) return;
    call.dismissed = true;
    await this.app.saveMessage(msg);
  }

  /** User decided on a "Permission required" card: 'approve' | 'deny' | 'always'. */
  async approve(messageId, callId, decision) {
    const msg = await this.app.getMessage(messageId);
    const call = findCall(msg, callId);
    if (!call || call.result) return;
    await this.recordApproval(msg, call, decision);
    return this.enqueue(msg.threadId, () => this.resume(messageId));
  }

  async retry(messageId) {
    const msg = await this.app.getMessage(messageId);
    if (!msg || msg.authorType !== 'agent') return;
    // Drop the failed step so the turn continues from the last good state.
    const last = msg.steps[msg.steps.length - 1];
    if (last && (last.error || (!last.text && !last.toolCalls?.length))) msg.steps.pop();
    msg.error = null;
    msg.status = 'streaming';
    await this.app.saveMessage(msg);
    return this.enqueue(msg.threadId, () => this.resume(messageId, { sameMessage: true }));
  }

  /** Delete a bot turn and run it again. */
  async regenerate(messageId) {
    const app = this.app;
    const msg = await app.getMessage(messageId);
    if (!msg || msg.authorType !== 'agent') return null;
    const msgs = await app.loadMessages(msg.threadId);
    const turnId = msg.turnId || msg.id;
    for (const m of msgs.filter((x) => (x.turnId || x.id) === turnId && x.authorId === msg.authorId)) await app.deleteMessage(m.id);
    const agent = app.getAgent(msg.authorId);
    if (!agent) return null;
    return this.enqueue(msg.threadId, () => this.runTurn({ agent, threadId: msg.threadId }));
  }

  async findWaiting(threadId) {
    const msgs = await this.app.loadMessages(threadId);
    for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 12; i--) {
      const m = msgs[i];
      if (m.authorType !== 'agent' || m.status !== 'waiting') continue;
      const step = m.steps[m.steps.length - 1];
      const call = step?.toolCalls?.find((c) => !c.result && (c.pending || c.approval?.status === 'pending'));
      if (call) return { message: m, call };
    }
    return null;
  }

  async closeLocalQuestion(msg, call, answer, { inChat = false } = {}) {
    call.answer = answer || null;
    call.answeredInChat = inChat;
    call.answeredAt = now();
    call.status = 'done';
    call.result = { content: answer ? `The user chose: ${answer}` : 'Answered in chat.' };
    msg.status = 'done';
    await this.app.saveMessage(msg);
  }

  async recordAnswer(msg, call, answer, { typed = false } = {}) {
    call.answer = answer;
    call.answeredAt = now();
    call.status = 'done';
    call.result = { content: typed ? `The user replied in chat: ${answer}` : `The user chose: ${answer}` };
    msg.status = 'done';
    await this.app.saveMessage(msg);
  }

  async recordApproval(msg, call, decision, { note } = {}) {
    call.approval = { ...(call.approval || {}), status: decision === 'deny' ? 'denied' : 'approved', decidedAt: now() };
    const tool = this.app.findToolAnywhere(call.name, this.app.getAgent(msg.authorId));
    if (decision !== 'deny' && tool?.approvalScope === 'turn' && msg.turn) {
      // One approval covers the rest of this task for screen/browser control.
      msg.turn.approved = [...new Set([...(msg.turn.approved || []), call.name])];
    }
    if (decision === 'always') {
      const agent = this.app.getAgent(msg.authorId);
      if (agent) await this.app.updateAgent(agent.id, { alwaysAllow: { ...(agent.alwaysAllow || {}), [call.name]: true } });
    }
    if (decision === 'deny') {
      call.status = 'error';
      call.result = { content: note ? `The user denied this action and said: ${note}` : 'The user denied this action. Do not retry it without asking.', isError: true };
    }
    msg.status = 'done';
    await this.app.saveMessage(msg);
  }

  /** Continue a paused/failed turn. */
  async resume(messageId, { sameMessage = false } = {}) {
    const msg = await this.app.getMessage(messageId);
    if (!msg) return null;
    const agent = this.app.getAgent(msg.authorId);
    if (!agent) return null;
    return this.runTurn({ agent, threadId: msg.threadId, resumeFrom: msg, sameMessage, depth: msg.depth || 0 });
  }

  // ----- the agent loop ---------------------------------------------------

  /**
   * Run (or resume) one bot turn in a thread.
   * @returns {Promise<{status: 'done'|'waiting'|'error'|'stopped', text: string, messageId: string, error?: string}>}
   */
  async runTurn({ agent, threadId, depth = 0, signal, resumeFrom = null, sameMessage = false, routine = null }) {
    const app = this.app;
    const thread = app.getThread(threadId);
    const controller = new AbortController();
    const unlink = linkSignal(signal, controller);

    // Turn identity: a resumed turn continues in a new message segment so the
    // conversation reads top-to-bottom (answer bubble, then the continuation).
    let msg;
    if (resumeFrom && sameMessage) {
      msg = resumeFrom;
    } else if (resumeFrom) {
      const pending = resumeFrom.steps[resumeFrom.steps.length - 1];
      const unfinished = pending?.toolCalls?.some((c) => !c.result);
      msg = await app.addMessage({
        threadId, authorType: 'agent', authorId: agent.id, status: 'streaming', depth,
        turnId: resumeFrom.turnId || resumeFrom.id, segment: (resumeFrom.segment || 0) + 1, steps: [], turn: resumeFrom.turn,
      });
      // Tool calls still waiting to run (e.g. approved after a pause) move into the new segment.
      if (unfinished) {
        resumeFrom.steps[resumeFrom.steps.length - 1] = { ...pending, carried: true };
        await app.saveMessage(resumeFrom);
      }
    } else {
      msg = await app.addMessage({ threadId, authorType: 'agent', authorId: agent.id, status: 'streaming', depth, steps: [], routineId: routine?.id });
      msg.turnId = msg.id;
    }
    msg.status = 'streaming';
    msg.error = null;
    this.runs.set(threadId, { controller, agentId: agent.id, messageId: msg.id, phase: 'thinking' });
    app.emitRuns();
    await app.updateThread(threadId, { status: 'working' });

    let cfg;
    let tools;
    try {
      cfg = app.providers.resolve(agent);
      const serverTools = app.providers.serverToolsFor(cfg, agent);
      // Gmail, Outlook or GitHub connected (or disconnected) on another device since.
      await app.refreshConnections({ maxAge: 60_000 });
      tools = toolsForAgent(app, agent, { nativeSearch: serverTools.includes('web_search') });
      if (!msg.turn) {
        if (!resumeFrom) await this.attachContext(agent, thread, msg, controller.signal);
        msg.turn = {
          system: buildSystemPrompt({ app, agent, thread: app.getThread(threadId), tools }),
          provider: cfg.provider.id,
          model: cfg.model,
          startedAt: now(),
          cutoffSeq: msg.seq,
        };
      }
      await app.saveMessage(msg);

      // Finish tool calls left over from a pause (approved actions, answered questions).
      if (resumeFrom && !sameMessage) {
        const carried = resumeFrom.steps[resumeFrom.steps.length - 1];
        if (carried?.carried && carried.toolCalls.some((c) => !c.result)) {
          const outcome = await this.executeCalls({ agent, thread, msg: resumeFrom, step: carried, tools, depth, signal: controller.signal, cfg });
          if (outcome === 'paused') return await this.pause(msg, resumeFrom, threadId, true);
        }
      } else if (resumeFrom && sameMessage) {
        const last = msg.steps[msg.steps.length - 1];
        if (last?.toolCalls?.some((c) => !c.result)) {
          const outcome = await this.executeCalls({ agent, thread, msg, step: last, tools, depth, signal: controller.signal, cfg });
          if (outcome === 'paused') return await this.pause(msg, msg, threadId);
        }
      }

      for (let i = 0; i < MAX_TOOL_STEPS; i++) {
        let history = await this.buildHistory(agent, threadId, msg, cfg.provider.id);
        const step = { id: uid('stp'), text: '', thinking: '', toolCalls: [], serverTools: [], citations: [], notices: [], startedAt: now() };
        msg.steps.push(step);
        app.touchMessage(msg);
        this.setPhase(threadId, 'thinking');

        const ask = (c) => app.providers.chat({
          cfg: c,
          system: msg.turn.system,
          messages: history,
          tools,
          serverTools: app.providers.serverToolsFor(c, agent),
          reasoningEffort: agent.effort || app.settings.defaults?.effort || undefined,
          maxTokens: agent.maxTokens || undefined,
          signal: controller.signal,
          onEvent: (e) => this.onStreamEvent(msg, step, e),
        });
        let result;
        try {
          result = await ask(cfg);
        } catch (err) {
          // Main provider down, rate limited or out of credit: retry this step once on the backup.
          const backup = controller.signal.aborted ? null : app.providers.backupFor(cfg, err);
          if (!backup) throw err;
          Object.assign(step, { text: '', thinking: '', toolCalls: [], serverTools: [], citations: [] });
          step.notices.push(`${cfg.provider.label} failed (${truncate(errorMessage(err), 140)}) — switched to ${backup.provider.label} for this reply.`);
          app.touchMessage(msg);
          cfg = backup;
          msg.steps.pop();
          history = await this.buildHistory(agent, threadId, msg, cfg.provider.id);
          msg.steps.push(step);
          result = await ask(cfg);
        }

        step.text = result.text;
        step.thinking = result.thinking || step.thinking;
        step.toolCalls = result.toolCalls.map((c) => ({ ...c, status: 'pending' }));
        step.raw = result.raw || null;
        step.provider = cfg.provider.id;
        step.usage = result.usage;
        step.model = result.model;
        step.stopReason = result.stopReason;
        if (result.citations?.length) step.citations = mergeCitations(step.citations, result.citations);
        step.endedAt = now();
        msg.model = result.model;
        msg.provider = cfg.provider.id;
        app.recordUsage(cfg.provider.id, result.model || cfg.model, result.usage);
        await app.saveMessage(msg);

        if (result.stopReason === 'pause') continue; // server-side tool loop wants to keep going
        if (result.stopReason === 'refusal') {
          step.notices.push('The model declined this request.');
          break;
        }
        if (!step.toolCalls.length) break;
        if (result.stopReason === 'max_tokens') {
          step.toolCalls = [];
          step.notices.push('The reply hit the output limit before the tool call finished.');
          break;
        }
        const outcome = await this.executeCalls({ agent, thread, msg, step, tools, depth, signal: controller.signal, cfg });
        if (outcome === 'paused') return await this.pause(msg, msg, threadId);
        if (i === MAX_TOOL_STEPS - 1) step.notices.push(`Stopped after ${MAX_TOOL_STEPS} tool steps.`);
      }

      msg.status = 'done';
      await app.saveMessage(msg);
      const text = finalText(msg);
      await this.finishThread(threadId, msg, agent);
      this.afterTurn(agent, threadId, msg).catch((err) => console.warn('post-turn memory work failed', err));
      return { status: 'done', text, messageId: msg.id };
    } catch (err) {
      const stopped = isAbort(err) || controller.signal.aborted;
      msg.status = stopped ? 'stopped' : 'error';
      msg.error = stopped ? null : errorMessage(err);
      msg.errorKind = err?.kind || (err?.status === 401 || err?.status === 403 ? 'auth' : null);
      const last = msg.steps[msg.steps.length - 1];
      if (last && !last.endedAt) {
        last.endedAt = now();
        if (!last.text && !last.toolCalls?.length && !stopped) last.error = msg.error;
      }
      for (const step of msg.steps) {
        for (const c of step.toolCalls || []) {
          if (!c.result) {
            c.status = 'error';
            c.result = { content: stopped ? 'Stopped by the user.' : `Not run: ${msg.error}`, isError: true };
          }
        }
      }
      await app.saveMessage(msg);
      await this.finishThread(threadId, msg, agent);
      if (!stopped) console.warn(`turn failed for ${agent.name}`, err);
      return { status: msg.status, text: finalText(msg), error: msg.error, messageId: msg.id };
    } finally {
      unlink();
      if (this.runs.get(threadId)?.messageId === msg.id) this.runs.delete(threadId);
      app.emitRuns();
    }
  }

  async pause(msg, waitingMsg, threadId, carried = false) {
    const app = this.app;
    waitingMsg.status = 'waiting';
    await app.saveMessage(waitingMsg);
    if (carried && msg !== waitingMsg) {
      // Nothing streamed into the fresh segment; drop it to avoid an empty bubble.
      if (!msg.steps.length) await app.deleteMessage(msg.id);
      else {
        msg.status = 'done';
        await app.saveMessage(msg);
      }
    }
    const step = waitingMsg.steps[waitingMsg.steps.length - 1];
    const call = step.toolCalls.find((c) => !c.result && (c.pending || c.approval?.status === 'pending'));
    const agent = app.getAgent(waitingMsg.authorId);
    const preview = call?.pending?.kind === 'question'
      ? { kind: 'waiting', text: `Waiting for you: ${call.pending.question}` }
      : { kind: 'permission', text: `Permission required: ${call?.approval?.summary || call?.name}` };
    await app.updateThread(threadId, { status: 'waiting', preview: { ...preview, authorId: agent?.id, at: now() }, unread: !app.isViewing(threadId) || app.hidden() });
    app.notify(agent, preview.text, threadId);
    return { status: 'waiting', text: finalText(waitingMsg), messageId: waitingMsg.id };
  }

  async finishThread(threadId, msg, agent) {
    const app = this.app;
    const text = finalText(msg);
    const files = msg.steps.flatMap((s) => (s.toolCalls || []).filter((c) => c.display?.kind === 'file'));
    let preview;
    if (msg.status === 'error') preview = { kind: 'error', text: `Error: ${truncate(msg.error || '', 80)}` };
    else if (files.length && !text) preview = { kind: 'file', text: `Sent ${files.length} ${fileNoun(files)}` };
    else preview = { kind: 'normal', text: truncate(text.replace(/\s+/g, ' '), 140) || (msg.status === 'stopped' ? 'Stopped' : '') };
    const thread = app.getThread(threadId);
    const viewing = app.isViewing(threadId) && !app.hidden();
    await app.updateThread(threadId, {
      status: 'idle',
      preview: { ...preview, authorId: agent.id, at: now() },
      unread: thread?.kind === 'agents' ? false : (viewing ? false : true),
    });
    if (thread?.kind !== 'agents' && !viewing && msg.status === 'done' && (text || files.length)) app.notify(agent, preview.text, threadId);
  }

  onStreamEvent(msg, step, e) {
    switch (e.type) {
      case 'text':
        step.text += e.text;
        break;
      case 'thinking':
        step.thinking += e.text;
        break;
      case 'tool_start':
        step.toolCalls.push({ id: e.id, name: e.name, args: {}, argsText: '', status: 'preparing' });
        break;
      case 'tool_args': {
        const c = step.toolCalls.find((x) => x.id === e.id);
        if (c) c.argsText += e.delta;
        break;
      }
      case 'server_tool': {
        let st = step.serverTools.find((x) => x.id === e.id);
        if (!st) {
          st = { id: e.id, name: e.name || 'web_search', status: 'running', input: e.input || {}, sources: [] };
          step.serverTools.push(st);
        }
        if (e.status === 'done') {
          st.status = e.error ? 'error' : 'done';
          st.sources = e.sources || [];
          st.error = e.error || null;
        }
        if (e.input && Object.keys(e.input).length) st.input = e.input;
        // The provider searching the web for the model is the bot at work.
        this.setPhase(msg.threadId, step.serverTools.some((x) => x.status === 'running') ? 'working' : 'thinking');
        break;
      }
      case 'server_tool_args': {
        const st = step.serverTools.find((x) => x.id === e.id);
        if (st) {
          st.argsText = (st.argsText || '') + e.delta;
          const q = st.argsText.match(/"(?:query|url)"\s*:\s*"((?:[^"\\]|\\.)*)/);
          if (q) st.input = { ...st.input, query: q[1] };
        }
        break;
      }
      case 'citation':
        step.citations = mergeCitations(step.citations, [{ url: e.url, title: e.title }]);
        break;
      case 'notice':
        step.notices.push(e.text);
        break;
      default:
        break;
    }
    this.app.touchMessage(msg);
  }

  /** Execute a step's tool calls. Returns 'paused' if the turn must wait for the user. */
  async executeCalls({ agent, thread, msg, step, tools, depth, signal, cfg = null }) {
    const app = this.app;
    this.setPhase(msg.threadId, 'working');
    const byName = new Map(tools.map((t) => [t.name, t]));
    const todo = step.toolCalls.filter((c) => !c.result);
    const runOne = async (call) => {
      const tool = byName.get(call.name) || app.findToolAnywhere(call.name, agent);
      if (!tool) {
        call.status = 'error';
        call.result = { content: `Unknown or disabled tool "${call.name}".`, isError: true };
        return null;
      }
      if (call.argsError) {
        call.status = 'error';
        call.result = { content: `Your arguments were not valid JSON: ${truncate(call.argsError, 300)}. Call the tool again with valid JSON.`, isError: true };
        return null;
      }
      const args = coerceArgs(tool.parameters, call.args || {});
      call.args = args;
      const invalid = validateArgs(tool.parameters, args);
      if (invalid) {
        call.status = 'error';
        call.result = { content: `Invalid arguments: ${invalid}.`, isError: true };
        return null;
      }
      call.label = safeLabel(tool, args);
      const risk = typeof tool.risk === 'function' ? tool.risk(args) : tool.risk || 'low';
      const turnApproved = tool.approvalScope === 'turn' && (msg.turn?.approved || []).includes(tool.name);
      // `alwaysAsk`: can't be undone (deleting a repository, or email for good), so it asks whatever Auto-review and Always allow say.
      const alwaysAsk = typeof tool.alwaysAsk === 'function' ? !!tool.alwaysAsk(args) : !!tool.alwaysAsk;
      const needsReview = alwaysAsk || (risk === 'high' && app.settings.autoReview !== false && !agent.alwaysAllow?.[tool.name] && !turnApproved);
      if (needsReview && call.approval?.status !== 'approved') {
        let summary = tool.approval ? tool.approval(args, { app, agent }) : call.label;
        // `preview`: what the call would do, looked up first (which emails a
        // delete reaches), to ask with. The approved call does exactly that
        // (`prepared`); with nothing to do, it finishes without asking.
        if (tool.preview) {
          let seen;
          try {
            seen = await tool.preview(args, { app, agent, thread, signal });
          } catch (err) {
            if (isAbort(err) || signal.aborted) throw err;
            call.status = 'error';
            call.result = { content: errorMessage(err), isError: true };
            return null;
          }
          if (seen?.result) {
            call.status = 'done';
            call.result = { content: seen.result.content ?? '', isError: false, images: [] };
            return null;
          }
          if (seen?.args) call.prepared = seen.args;
          if (seen?.summary) summary = seen.summary;
        }
        call.status = 'waiting';
        call.approval = { status: 'pending', summary, requestedAt: now() };
        return 'paused';
      }
      call.status = 'running';
      call.startedAt = now();
      app.touchMessage(msg);
      let res;
      try {
        res = await tool.run(call.prepared || args, {
          app, agent, thread, message: msg, callId: call.id, signal, depth, runtime: this,
          progress: (text) => {
            call.progress = text;
            app.touchMessage(msg);
          },
        });
      } catch (err) {
        if (isAbort(err) || signal.aborted) throw err;
        res = { content: errorMessage(err), isError: true };
      }
      call.endedAt = now();
      call.progress = null;
      if (res?.pending) {
        call.pending = res.pending;
        call.status = 'waiting';
        return 'paused';
      }
      call.status = res?.isError ? 'error' : 'done';
      call.display = res?.display || null;
      call.result = { content: res?.content ?? '', isError: !!res?.isError, images: res?.images || [] };
      if (call.result.images.length && cfg && !supportsVision(cfg.provider.id, cfg.model)) {
        // Text-only model: have a vision model describe the image(s) instead.
        const desc = await app.providers.describeImages(call.result.images, { hint: tool.name === 'computer' ? 'This is a screenshot of the computer screen the agent is operating.' : '', signal }).catch(() => null);
        call.result.content = `${call.result.content}\n\n${desc ? `What the image shows (described by a vision model):\n${desc}` : '[This model cannot see images and no vision model is configured.]'}`;
      }
      if (tool.group !== 'memory' && tool.name !== 'ask_user') {
        app.logActivity(agent.id, { type: 'tool', title: call.label, detail: truncate(String(call.result.content || ''), 300), isError: !!res?.isError, threadId: thread.id });
      }
      return null;
    };

    const allParallel = todo.length > 1 && todo.every((c) => PARALLEL_SAFE.has(c.name));
    if (allParallel) {
      await Promise.all(todo.map(runOne));
      await app.saveMessage(msg);
      return 'continue';
    }
    for (const call of todo) {
      const outcome = await runOne(call);
      await app.saveMessage(msg);
      if (outcome === 'paused') return 'paused';
    }
    return 'continue';
  }

  // ----- context --------------------------------------------------------

  /** Attach memory context for this bot to the newest incoming message it is answering. */
  async attachContext(agent, thread, msg, signal) {
    const app = this.app;
    const msgs = await app.loadMessages(thread.id);
    const incoming = [...msgs].reverse().find((m) => m.seq < msg.seq && m.authorId !== agent.id && !m.answerTo && (m.authorType === 'user' || m.authorType === 'agent' || m.forModel));
    if (!incoming || incoming.contexts?.[agent.id]) return;
    const prevOwn = [...msgs].reverse().find((m) => m.seq < incoming.seq && m.authorId === agent.id);
    const query = `${messageText(incoming)}\n${prevOwn ? truncate(finalText(prevOwn), 300) : ''}`.trim();
    let memories = [];
    if (agent.tools?.memory !== false || agent.memoryAuto !== false) {
      try {
        memories = await app.memory.search(agent.id, query, { limit: 8, includeShared: true });
      } catch (err) {
        console.warn('memory search failed', err);
      }
    }
    if (signal?.aborted) return;
    incoming.contexts = { ...(incoming.contexts || {}), [agent.id]: buildMessageContext({ app, memories }) };
    await app.saveMessage(incoming);
  }

  /**
   * Convert the thread into provider-neutral messages from this bot's point of view.
   * Completed turns are rendered without provider-specific blocks; the in-progress
   * turn replays them verbatim (thinking signatures, server tool results).
   */
  async buildHistory(agent, threadId, current, cfgProvider = null) {
    const app = this.app;
    const thread = app.getThread(threadId);
    const all = await app.loadMessages(threadId);
    const turnId = current.turnId || current.id;
    const cutoff = current.turn?.cutoffSeq ?? current.seq;
    const userName = app.settings.profile?.name || 'User';
    const group = thread.kind !== 'dm';
    const out = [];

    const visible = all.filter((m) => {
      if (m.hidden || m.answerTo) return false;
      if ((m.turnId || m.id) === turnId && m.authorId === agent.id) return true;
      return m.seq < cutoff && m.seq > (thread.summaryUpToSeq || 0);
    });

    for (const m of visible) {
      if (m.authorType === 'system') {
        if (m.forModel) out.push({ role: 'user', parts: [{ type: 'text', text: messageText(m) }] });
        continue;
      }
      if (m.authorType === 'user') {
        const parts = await app.partsForModel(m, agent);
        const ctx = m.contexts?.[agent.id];
        if (group && parts[0]?.type === 'text') parts[0] = { ...parts[0], text: `[${userName}]: ${parts[0].text}` };
        out.push({ role: 'user', parts: ctx ? [{ type: 'text', text: ctx }, ...parts] : parts });
        continue;
      }
      if (m.authorId !== agent.id) {
        const other = app.getAgent(m.authorId);
        const ctx = m.contexts?.[agent.id];
        const label = m.delivery?.kind === 'task_result' ? `[Task result from ${other?.name || 'a bot'}]` : `[${other?.name || 'Another bot'}]:`;
        const body = messageText(m) || (m.status === 'error' ? `(failed: ${m.error})` : '(no reply)');
        out.push({ role: 'user', parts: [...(ctx ? [{ type: 'text', text: ctx }] : []), { type: 'text', text: `${label} ${body}` }] });
        continue;
      }
      const inProgress = (m.turnId || m.id) === turnId;
      for (const step of m.steps || []) {
        const calls = (step.toolCalls || []).filter((c) => c.name && !c.local);
        const text = step.text || '';
        if (!text && !calls.length && !(inProgress && step.raw)) continue;
        if (!inProgress && !text && !calls.length) continue;
        const hasAllResults = calls.every((c) => c.result);
        // A step still being generated has no final shape yet.
        if (inProgress && step === current.steps[current.steps.length - 1] && !step.endedAt) continue;
        out.push({
          role: 'assistant',
          parts: text ? [{ type: 'text', text }] : [],
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args || {} })),
          raw: inProgress ? step.raw : null,
          // Verbatim reasoning for providers that require it on every turn (DeepSeek thinking + tools).
          reasoning: step.provider === cfgProvider ? (step.raw?.reasoning_content ?? null) : null,
        });
        if (calls.length) {
          if (!hasAllResults && inProgress) {
            // Pending results are appended once the tools finish; stop here.
            break;
          }
          out.push({
            role: 'tool',
            results: calls.map((c) => ({
              id: c.id,
              name: c.name,
              content: c.result ? String(c.result.content ?? '') : '(no result — interrupted)',
              isError: !!c.result?.isError || !c.result,
              images: inProgress ? (c.result?.images || []) : [],
            })),
          });
        }
      }
    }

    let cfg = null;
    try {
      cfg = app.providers.resolve(agent);
    } catch { /* no key: budget falls back to the default window */ }
    return trimToBudget(out, this.historyBudget(agent, cfg));
  }

  /**
   * How much raw conversation a bot keeps verbatim before older turns are
   * summarized. "auto" = half the model's context window (capped at 400k tokens),
   * so long-context models like DeepSeek V4.1 Flash keep a very long history.
   */
  historyBudget(agent, cfg = null) {
    const setting = agent.contextBudget || this.app.settings.memory?.contextBudget || 'auto';
    if (setting !== 'auto' && Number(setting) > 0) return Number(setting);
    if (!cfg) {
      try {
        cfg = this.app.providers.resolve(agent);
      } catch {
        return 64000;
      }
    }
    return Math.min(Math.round(contextWindow(cfg.provider.id, cfg.model) * 0.5), 400000);
  }

  // ----- bots talking to bots ----------------------------------------------

  /** message_agent: `from` asks `to` something and waits for the reply. */
  async converse({ from, to, text, depth = 1, signal }) {
    const app = this.app;
    const thread = await app.ensureAgentThread(from.id, to.id);
    if (this.isThreadBusy(thread.id)) {
      return { threadId: thread.id, text: '', error: `${to.name} is already in a conversation with ${from.name}; reply to it directly instead.` };
    }
    await app.addMessage({ threadId: thread.id, authorType: 'agent', authorId: from.id, parts: [{ type: 'text', text }] });
    const res = await this.enqueue(thread.id, () => this.runTurn({ agent: to, threadId: thread.id, depth, signal }));
    return { threadId: thread.id, text: res?.status === 'waiting' ? `${res.text}\n\n(${to.name} is waiting for the user's approval before continuing.)`.trim() : res?.text || '', error: res?.error };
  }

  /** delegate_task: run in the background, then deliver the result back into the requester's chat. */
  async delegate({ from, to, task, replyThreadId, depth = 1 }) {
    const app = this.app;
    const record = await app.saveTask({
      id: uid('task'), fromAgentId: from.id, toAgentId: to.id, task, status: 'running', createdAt: now(), replyThreadId,
    });
    (async () => {
      const res = await this.converse({
        from, to, depth,
        text: `[Task from ${from.name}] ${task}\n\nWork on this now with your tools. When you're done, reply with the complete result (it will be passed back to ${from.name}).`,
      });
      await app.saveTask({ ...record, status: res.error && !res.text ? 'failed' : 'done', result: res.text, error: res.error, completedAt: now() });
      const delivery = await app.addMessage({
        threadId: replyThreadId, authorType: 'agent', authorId: to.id,
        parts: [{ type: 'text', text: res.text || `I couldn't finish: ${res.error || 'no result'}` }],
        delivery: { kind: 'task_result', taskId: record.id, forAgentId: from.id, task },
      });
      const replyThread = app.getThread(replyThreadId);
      if (!replyThread) return;
      const reporter = replyThread.kind === 'dm' ? app.getAgent(replyThread.agentIds[0]) : from;
      if (reporter) await this.enqueue(replyThreadId, () => this.runTurn({ agent: reporter, threadId: replyThreadId, depth: 0 }));
      return delivery;
    })().catch((err) => console.warn('delegated task failed', err));
    return record;
  }

  // ----- group chats ------------------------------------------------------

  async runGroup(thread, trigger) {
    const app = this.app;
    const members = thread.agentIds.map((id) => app.getAgent(id)).filter(Boolean);
    if (!members.length) return null;
    const text = messageText(trigger);
    let queue = mentionedAgents(text, members);
    if (!queue.length) {
      // "@Mentions" groups: only bots that are mentioned reply.
      if (thread.mode === 'mention') return null;
      queue = thread.mode === 'all' ? [...members] : await this.pickSpeakers(thread, members, trigger);
    }
    const spoken = new Set();
    let hops = 0;
    let last = null;
    while (queue.length && hops < GROUP_MAX_HOPS) {
      const agent = queue.shift();
      hops++;
      const res = await this.runTurn({ agent, threadId: thread.id });
      last = res;
      spoken.add(agent.id);
      if (res.status !== 'done') {
        if (res.status === 'waiting' || res.status === 'stopped') break;
        continue;
      }
      if (/^\s*\[PASS\]\s*$/i.test(res.text)) {
        const m = await app.getMessage(res.messageId);
        if (m) {
          m.hidden = true;
          await app.saveMessage(m);
        }
        continue;
      }
      for (const next of mentionedAgents(res.text, members)) {
        if (next.id !== agent.id && !queue.includes(next)) queue.push(next);
      }
    }
    return last;
  }

  /** Ask a model which members should respond; falls back to everyone. */
  async pickSpeakers(thread, members, trigger) {
    if (members.length === 1) return members;
    const app = this.app;
    try {
      const recent = (await app.loadMessages(thread.id)).filter((m) => !m.hidden).slice(-8);
      const transcript = recent.map((m) => `${m.authorType === 'user' ? app.settings.profile?.name || 'User' : app.getAgent(m.authorId)?.name || 'Bot'}: ${truncate(messageText(m), 400)}`).join('\n');
      const roster = members.map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ''}${a.persona ? ` (${truncate(a.persona, 120)})` : ''}`).join('\n');
      const out = await app.providers.complete({
        agent: members[0],
        purpose: 'memory',
        system: 'You route messages in a group chat between a user and several AI bots. Pick who should answer the latest message: usually 1–2 bots whose role fits best, or all bots if the user addresses everyone or asks for opinions. Reply with JSON only: {"speakers":["Name", ...]}.',
        prompt: `Bots:\n${roster}\n\nRecent messages:\n${transcript}\n\nLatest message: ${truncate(messageText(trigger), 1500)}`,
        json: true,
        maxTokens: 300,
      });
      const names = extractJson(out)?.speakers || [];
      const picked = names.map((n) => members.find((a) => normalizeName(a.name) === normalizeName(n))).filter(Boolean);
      if (picked.length) return [...new Set(picked)];
    } catch (err) {
      console.warn('speaker selection failed; everyone answers', err);
    }
    return [...members];
  }

  // ----- routines -------------------------------------------------------

  async runRoutine(routine) {
    const app = this.app;
    const agent = app.getAgent(routine.agentId);
    if (!agent) return null;
    const thread = await app.ensureDmThread(agent.id);
    await app.routines.markRan(routine.id);
    await app.addMessage({
      threadId: thread.id, authorType: 'system', authorId: 'routine', forModel: true, routineId: routine.id,
      parts: [{ type: 'text', text: `[Routine “${routine.title}” — scheduled run at ${new Date().toLocaleString()}]\n${routine.prompt}` }],
    });
    return this.enqueue(thread.id, () => this.runTurn({ agent, threadId: thread.id, routine }));
  }

  // ----- memory work after each turn -------------------------------------

  afterTurn(agent, threadId, msg) {
    const prev = this.bgQueues.get(agent.id) || Promise.resolve();
    const job = prev.catch(() => {}).then(() => this.memoryJobs(agent.id, threadId, msg));
    this.bgQueues.set(agent.id, job);
    return job;
  }

  async memoryJobs(agentId, threadId, msg) {
    const app = this.app;
    const agent = app.getAgent(agentId);
    if (!agent) return;
    const thread = app.getThread(threadId);
    const auto = agent.memoryAuto !== false && app.settings.memory?.auto !== false;
    const llm = (req) => app.providers.complete({ agent, purpose: 'memory', ...req });

    if (auto && msg.status === 'done' && thread) {
      const msgs = await app.loadMessages(threadId);
      const idx = msgs.findIndex((m) => m.id === msg.id);
      const before = msgs.slice(Math.max(0, idx - 6), idx).filter((m) => !m.hidden && m.authorId !== agentId);
      const incoming = before.filter((m) => m.authorType === 'user' || m.authorType === 'agent').slice(-2);
      const speakerOf = (m) => (m.authorType === 'user' ? (app.settings.profile?.name || 'User') : app.getAgent(m.authorId)?.name || 'Bot');
      const exchange = [
        ...incoming.map((m) => ({ speaker: speakerOf(m), text: messageText(m) })),
        { speaker: agent.name, text: finalText(msg) },
      ].filter((e) => e.text);
      if (exchange.length >= 2 || (thread.kind === 'dm' && exchange.length)) {
        try {
          const applied = await extractAndApply({
            llm, store: app.memory, agentId, agentName: agent.name, userName: app.settings.profile?.name,
            exchange, source: { threadId, messageId: msg.id },
          });
          if (applied.length) {
            msg.memoryOps = applied.map((a) => ({ op: a.op, text: a.memory.text }));
            await app.saveMessage(msg);
            const added = applied.filter((a) => a.op === 'add').length;
            await app.updateAgent(agentId, { memSinceReflection: (agent.memSinceReflection || 0) + added });
          }
        } catch (err) {
          console.warn('memory extraction failed', err);
          app.logActivity(agentId, { type: 'memory', title: 'Memory update failed', detail: errorMessage(err), isError: true });
        }
      }
    }

    await this.compactIfNeeded(agent, threadId, llm).catch((err) => console.warn('compaction failed', err));

    const fresh = app.getAgent(agentId);
    if (auto && fresh && (fresh.memSinceReflection || 0) >= 12) {
      try {
        const top = (await app.memory.search(agentId, '', { limit: 40, touch: false })).map((r) => r.memory);
        const insights = await reflect({ llm, agentName: fresh.name, memories: top.map((m) => ({ memory: m })) });
        for (const ins of insights) await app.memory.add(agentId, { text: ins.text, type: 'reflection', importance: ins.importance, source: { kind: 'reflection' } });
        const profile = await synthesizeProfile({
          llm, agentName: fresh.name, currentProfile: fresh.core?.human || '',
          memories: top.filter((m) => m.type !== 'reflection').slice(0, 30).map((m) => ({ memory: m })),
        });
        await app.updateAgent(agentId, {
          memSinceReflection: 0,
          lastReflectionAt: now(),
          ...(profile ? { core: { ...(fresh.core || {}), human: truncate(profile, 2000) } } : {}),
        });
      } catch (err) {
        console.warn('reflection failed', err);
      }
    }
  }

  /** Fold old messages into the thread summary once the history outgrows the budget. */
  async compactIfNeeded(agent, threadId, llm) {
    const app = this.app;
    const thread = app.getThread(threadId);
    if (!thread || this.isThreadBusy(threadId)) return;
    const budget = this.historyBudget(agent);
    const msgs = (await app.loadMessages(threadId)).filter((m) => m.seq > (thread.summaryUpToSeq || 0) && !m.hidden);
    const cost = (m) => estimateTokens(messageText(m)) + (m.steps || []).reduce((s, st) => s + estimateTokens(st.text) + (st.toolCalls || []).reduce((a, c) => a + estimateTokens(JSON.stringify(c.args || {})) + estimateTokens(String(c.result?.content || '').slice(0, 20000)), 0), 0);
    const total = msgs.reduce((s, m) => s + cost(m), 0);
    if (total < budget * 0.85) return;
    // Summarize the oldest ~60%, cutting at a user message so turns stay intact.
    let acc = 0;
    let cutIdx = 0;
    for (let i = 0; i < msgs.length; i++) {
      acc += cost(msgs[i]);
      if (acc >= total * 0.6) {
        cutIdx = i;
        break;
      }
    }
    while (cutIdx < msgs.length - 1 && !(msgs[cutIdx + 1].authorType === 'user' && !msgs[cutIdx + 1].answerTo)) cutIdx++;
    if (cutIdx >= msgs.length - 1) return;
    const chunk = msgs.slice(0, cutIdx + 1);
    const nameOf = (m) => (m.authorType === 'user' ? (app.settings.profile?.name || 'User') : m.authorType === 'system' ? 'System' : app.getAgent(m.authorId)?.name || 'Bot');
    const summary = await summarizeHistory({
      llm,
      agentName: agent.name,
      previousSummary: thread.summary || '',
      messages: chunk.map((m) => ({ speaker: nameOf(m), text: messageText(m) || finalText(m) })).filter((x) => x.text),
    });
    if (summary) await app.updateThread(threadId, { summary, summaryUpToSeq: chunk[chunk.length - 1].seq, summarizedAt: now() });
  }
}

// ----- helpers ------------------------------------------------------------

function linkSignal(parent, controller) {
  if (!parent) return () => {};
  if (parent.aborted) controller.abort(parent.reason);
  const on = () => controller.abort(parent.reason);
  parent.addEventListener('abort', on, { once: true });
  return () => parent.removeEventListener('abort', on);
}

export function findCall(msg, callId) {
  for (const s of msg?.steps || []) for (const c of s.toolCalls || []) if (c.id === callId) return c;
  return null;
}

export function messageText(m) {
  if (!m) return '';
  if (m.authorType === 'agent' && m.steps) return finalText(m) || (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

/** The visible reply of an agent message: text of its steps, joined. */
export function finalText(m) {
  if (!m) return '';
  if (!m.steps?.length) return (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
  return m.steps.map((s) => s.text || '').filter(Boolean).join('\n\n').trim();
}

function mergeCitations(a = [], b = []) {
  const seen = new Set(a.map((c) => c.url));
  const out = [...a];
  for (const c of b) if (c?.url && !seen.has(c.url)) {
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

function safeLabel(tool, args) {
  try {
    return typeof tool.label === 'function' ? tool.label(args) : tool.label || tool.name;
  } catch {
    return tool.name;
  }
}

function fileNoun(files) {
  const exts = new Set(files.map((f) => (f.display?.name || '').split('.').pop().toLowerCase()));
  if (exts.size === 1) {
    const e = [...exts][0];
    const names = { md: 'Markdown file', csv: 'CSV file', pdf: 'PDF', png: 'image', jpg: 'image', json: 'JSON file', html: 'HTML file', txt: 'text file', py: 'Python file' };
    const n = names[e] || 'file';
    return files.length > 1 ? `${n}s` : n;
  }
  return files.length > 1 ? 'files' : 'file';
}

/** @-mentions of group members, in order of appearance. */
export function mentionedAgents(text, members) {
  const found = [];
  const re = /@([\p{L}\p{N}_.-]+(?:\s[\p{L}\p{N}_.-]+)?)/gu;
  let m;
  while ((m = re.exec(text || ''))) {
    const token = normalizeName(m[1]);
    const hit = members.find((a) => token.startsWith(normalizeName(a.name)) || normalizeName(a.name).startsWith(token.split(' ')[0]));
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/** Drop the oldest turns until the estimated size fits, never splitting a tool call from its result. */
export function trimToBudget(messages, budget) {
  const size = (m) => estimateTokens(JSON.stringify(m.parts || m.results || '')) + estimateTokens(JSON.stringify(m.toolCalls || ''))
    + ((m.parts || []).some((p) => p.type === 'image') ? 1500 : 0);
  const starts = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') starts.push(i);
  });
  if (!starts.length) return messages;
  let total = messages.reduce((s, m) => s + size(m), 0);
  let k = 0;
  let start = starts[0];
  for (let i = 0; i < start; i++) total -= size(messages[i]);
  while (total > budget && k < starts.length - 1) {
    const next = starts[k + 1];
    for (let i = start; i < next; i++) total -= size(messages[i]);
    k++;
    start = next;
  }
  return start === 0 ? messages : messages.slice(start);
}
