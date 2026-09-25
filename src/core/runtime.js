import { uid, now, truncate, estimateTokens, errorMessage, isAbort, normalizeName, sleep } from './util.js';
import { toolsForAgent, validateArgs, coerceArgs } from './tools/index.js';
import { CONNECTOR_READS } from './tools/connector-tools.js';
import { buildSystemPrompt, buildMessageContext } from './prompts.js';
import { extractAndApply, summarizeHistory, synthesizeProfile, reflect } from './memory/extract.js';
import { MAX_TOOL_STEPS } from './constants.js';
import { CONTENT_NOTE } from './safety.js';
import { contextWindow, supportsVision } from './providers/index.js';
import { extractJson } from './util.js';
import { phrase, spoken } from './i18n.js';

// The agent runtime: builds each bot's context, streams model output, runs
// tools, pauses for approvals / questions, lets bots talk to each other, and
// runs background memory work. Everything is persisted as it happens, so a
// paused turn can resume after a reload.

const PARALLEL_SAFE = new Set(['recall', 'search_history', 'web_search', 'fetch_url', 'message_agent', 'list_files', 'read_file', 'list_agents', ...CONNECTOR_READS]);
const GROUP_MAX_HOPS = 8;
/** For the bot, on the newest message when it came in while the bot was busy
 * with a task (Runtime.send, interrupt). */
const INTERRUPTED_NOTE = '[This message came in while you were in the middle of a task, which is paused. Answer it first. Then, unless it tells you to stop or do something else, carry on with that task from where you left off.]';
/** For the bot, on the newest message when its last reply was stopped (Stop,
 * or the app closing) before it finished. */
const STOPPED_NOTE = '[The user stopped your last reply before you finished. Anything you were in the middle of may not have happened. If this message asks you to continue, pick the task back up from where you left off: check what already got done, then carry on. Otherwise, do what it asks.]';
/** For the bot, on the newest message every turn: what it's asked most to
 * keep (buildSystemPrompt's About yourself), where it weighs most, past a
 * chat full of what it said before. */
const SELF_NOTE = '[Note to you, not from the user: how you and the other bots are built, set up and run stays private. If this message asks about any of it (what you run on, whether the bots share a computer or anything else, how you work, what model you are, who made you), you don\'t know: answer in one light sentence that says only that, without mentioning anything you said before, and offer to help with something else. Otherwise, ignore this note.]';
/** Results for tool calls a Stop cut off (settleStopped). */
const STOPPED_RUNNING = 'Stopped by the user while this was running, so it may not have finished. Check before doing it again.';
const STOPPED_BEFORE = 'Not run: the user stopped the task first.';
/** For the bot, once it has used every tool step of a turn (sayWhereThingsStand). */
const OUT_OF_STEPS_NOTE = '[You\'ve used every tool step you get for one reply, so no more tool calls: any you make won\'t run. In a few sentences, tell the user what you got done, what\'s left, and what\'s in your way, if anything (a tool that keeps failing, something you can\'t reach, something you need from them). Don\'t repeat what you already said.]';
/** How long what's sent after a Stop waits for the stopped turn to wind down. */
const STOP_GRACE_MS = 3000;

export class Runtime {
  constructor(app) {
    this.app = app;
    this.runs = new Map(); // threadId -> { controller, agentId, messageId, phase, msg, agent }
    this.queues = new Map(); // threadId -> Promise chain
    this.halts = new Map(); // threadId -> AbortController a Stop in that thread fires (stop)
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
    return [...this.runs.entries()].map(([threadId, r]) => ({ threadId, agentId: r.agentId, messageId: r.messageId, phase: r.phase }));
  }

  /**
   * Stop: whatever the bots are doing in this chat ends now, whatever it is.
   * The reply being written stops (what it wrote stays), a running tool is
   * dropped (a shell command is killed), turns waiting behind it don't start,
   * and tasks handed from this chat to other bots are called off. The chat is
   * free at once, even if the turn takes a moment to wind down, and the next
   * message has the bot pick up where it left off (STOPPED_NOTE).
   */
  stop(threadId) {
    const reason = new DOMException('Stopped by user', 'AbortError');
    const run = this.runs.get(threadId);
    if (run) run.stopped = true;
    const halt = this.halts.get(threadId);
    this.halts.delete(threadId);
    halt?.abort(reason);
    if (run) {
      run.controller.abort(reason);
      this.runs.delete(threadId);
      this.app.emitRuns();
      // A turn that hasn't wound down by now (stuck on something that
      // doesn't listen for the stop) is marked stopped all the same.
      setTimeout(() => {
        if (run.msg.status === 'streaming') this.settleStopped(threadId, run.msg, run.agent).catch((err) => console.warn('stop', err));
      }, STOP_GRACE_MS);
    }
    // What's sent next doesn't wait on a stopped turn for long.
    const queue = this.queues.get(threadId);
    if (queue) {
      const released = Promise.race([queue, sleep(STOP_GRACE_MS)]);
      this.queues.set(threadId, released);
      released.finally(() => {
        if (this.queues.get(threadId) === released) this.queues.delete(threadId);
      });
    }
  }

  stopAll() {
    for (const threadId of new Set([...this.runs.keys(), ...this.halts.keys(), ...this.queues.keys()])) this.stop(threadId);
  }

  /** The signal a Stop in this thread fires (stop): the running turn, turns
   * queued behind it and tasks delegated from the thread all listen for it. */
  haltFor(threadId) {
    let halt = this.halts.get(threadId);
    if (!halt) this.halts.set(threadId, (halt = new AbortController()));
    return halt.signal;
  }

  /** A new message came in while the bot works in this thread: it stops what
   * it's doing right away (the reply it's writing, a tool that's running), so
   * the next turn can answer, then carry on (cutShort). */
  interrupt(threadId) {
    const run = this.runs.get(threadId);
    if (!run) return;
    run.interrupted = true;
    run.controller.abort(new DOMException('Interrupted', 'AbortError'));
  }

  /** Serialize work per thread so turns never interleave. `fn(halt)` gets the
   * thread's stop signal (haltFor), and doesn't run if a Stop fired it first. */
  enqueue(threadId, fn) {
    const halt = this.haltFor(threadId);
    const prev = this.queues.get(threadId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => (halt.aborted ? { status: 'stopped', text: '', messageId: null } : fn(halt)));
    const tail = next.catch(() => {}).finally(() => {
      if (this.queues.get(threadId) === tail) this.queues.delete(threadId);
    });
    this.queues.set(threadId, tail);
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
    // The bot is busy with a task in this chat: it stops (interrupt), answers
    // this, then picks the task back up (the note this message carries says
    // so: buildHistory).
    const busy = !waiting && thread.kind !== 'group' ? this.runs.get(threadId) : null;
    const userMsg = await app.addMessage({
      threadId, authorType: 'user', authorId: 'user', parts,
      ...(waiting ? { answerTo: { messageId: waiting.message.id, callId: waiting.call.id } } : {}),
      ...(busy ? { interrupts: busy.messageId } : {}),
    });
    if (waiting) {
      const answer = text.trim() || '(sent an attachment)';
      if (waiting.call.pending?.kind === 'question') await this.recordAnswer(waiting.message, waiting.call, answer, { typed: true });
      else await this.recordApproval(waiting.message, waiting.call, 'deny', { note: answer });
      return this.enqueue(threadId, (halt) => this.resume(waiting.message.id, { halt }));
    }
    if (thread.kind === 'group') return this.enqueue(threadId, (halt) => this.runGroup(thread, userMsg, halt));
    const agent = app.getAgent(thread.agentIds[0]);
    if (!agent) throw new Error('This bot no longer exists');
    if (busy) this.interrupt(threadId);
    return this.enqueue(threadId, (halt) => this.runTurn({ agent, threadId, halt }));
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
      return this.enqueue(msg.threadId, (halt) => this.runTurn({ agent, threadId: msg.threadId, halt }));
    }
    await this.recordAnswer(msg, call, Array.isArray(answer) ? answer.join(', ') : answer);
    return this.enqueue(msg.threadId, (halt) => this.resume(messageId, { halt }));
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
    return this.enqueue(msg.threadId, (halt) => this.resume(messageId, { halt }));
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
    return this.enqueue(msg.threadId, (halt) => this.resume(messageId, { sameMessage: true, halt }));
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
    return this.enqueue(msg.threadId, (halt) => this.runTurn({ agent, threadId: msg.threadId, halt }));
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
  async resume(messageId, { sameMessage = false, halt } = {}) {
    const msg = await this.app.getMessage(messageId);
    if (!msg) return null;
    const agent = this.app.getAgent(msg.authorId);
    if (!agent) return null;
    return this.runTurn({ agent, threadId: msg.threadId, resumeFrom: msg, sameMessage, depth: msg.depth || 0, halt });
  }

  // ----- the agent loop ---------------------------------------------------

  /**
   * Run (or resume) one bot turn in a thread.
   * @returns {Promise<{status: 'done'|'waiting'|'error'|'stopped', text: string, messageId: string, error?: string}>}
   */
  async runTurn({ agent, threadId, depth = 0, signal, halt = this.haltFor(threadId), resumeFrom = null, sameMessage = false, routine = null }) {
    const app = this.app;
    // Stopped before it began (a Stop here, or in the chat of the bot that asked for this).
    if (signal?.aborted || halt.aborted) return { status: 'stopped', text: '', messageId: null };
    const thread = app.getThread(threadId);
    const controller = new AbortController();
    const unlink = linkSignal(signal, controller);
    const unlinkHalt = linkSignal(halt, controller);

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
    const run = { controller, agentId: agent.id, messageId: msg.id, phase: 'thinking', msg, agent };
    // (Stopped while its message was being made: it winds down at once, below.)
    if (!controller.signal.aborted) {
      this.runs.set(threadId, run);
      app.emitRuns();
    }

    let cfg;
    let tools;
    try {
      await app.updateThread(threadId, { status: 'working' });
      // Whether Holly Bot's AI can run, and the credits for it (convex/credits.ts).
      await untilAborted(app.refreshCredits({ maxAge: 60_000 }), controller.signal);
      cfg = app.providers.resolve(agent);
      const serverTools = app.providers.serverToolsFor(cfg, agent);
      // Gmail, Outlook or GitHub connected (or disconnected) on another device since.
      await untilAborted(app.refreshConnections({ maxAge: 60_000 }), controller.signal);
      tools = toolsForAgent(app, agent, { nativeSearch: serverTools.includes('web_search'), thread: app.getThread(threadId) });
      if (!msg.turn) {
        if (!resumeFrom) await untilAborted(this.attachContext(agent, thread, msg, controller.signal), controller.signal);
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
        if (run.interrupted) break;
        if (controller.signal.aborted) throw abortError(controller.signal);
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
        // Stopped as the reply came in: a stream cut off can end as if it were
        // done, so what came back is only what got written before the stop.
        if (controller.signal.aborted) throw abortError(controller.signal);

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
        if (i === MAX_TOOL_STEPS - 1) {
          step.notices.push(`Stopped after ${MAX_TOOL_STEPS} tool steps.`);
          if (!run.interrupted) await this.sayWhereThingsStand({ agent, threadId, msg, cfg, tools, signal: controller.signal });
        }
      }

      // A Stop that came as the last step finished still stops the turn.
      if (run.stopped) throw abortError(controller.signal);
      if (run.interrupted) return await this.cutShort(msg);
      msg.status = 'done';
      await app.saveMessage(msg);
      const text = finalText(msg);
      await this.finishThread(threadId, msg, agent);
      this.afterTurn(agent, threadId, msg).catch((err) => console.warn('post-turn memory work failed', err));
      return { status: 'done', text, messageId: msg.id };
    } catch (err) {
      if (run.interrupted && !run.stopped) return await this.cutShort(msg);
      if (run.stopped || isAbort(err) || controller.signal.aborted) return await this.settleStopped(threadId, msg, agent, resumeFrom);
      msg.status = 'error';
      msg.error = errorMessage(err);
      msg.errorKind = err?.kind || (err?.code === 'no_credits' ? 'credits' : err?.status === 401 || err?.status === 403 ? 'auth' : null);
      const last = msg.steps[msg.steps.length - 1];
      if (last && !last.endedAt) {
        last.endedAt = now();
        if (!last.text && !last.toolCalls?.length) last.error = msg.error;
      }
      for (const step of msg.steps) {
        for (const c of step.toolCalls || []) {
          if (!c.result) {
            c.status = 'error';
            c.result = { content: `Not run: ${msg.error}`, isError: true };
          }
        }
      }
      await app.saveMessage(msg);
      await this.finishThread(threadId, msg, agent);
      console.warn(`turn failed for ${agent.name}`, err);
      return { status: msg.status, text: finalText(msg), error: msg.error, messageId: msg.id };
    } finally {
      unlink();
      unlinkHalt();
      if (this.runs.get(threadId)?.messageId === msg.id) this.runs.delete(threadId);
      app.emitRuns();
    }
  }

  /**
   * Out of tool steps: one more reply, with nothing it asks for run, tells the
   * user what got done and what's in the way, so a turn never ends without a
   * word. (The tools stay listed: some providers refuse a history of tool
   * calls without them.)
   */
  async sayWhereThingsStand({ agent, threadId, msg, cfg, tools, signal }) {
    const app = this.app;
    const history = await this.buildHistory(agent, threadId, msg, cfg.provider.id);
    history.push({ role: 'user', parts: [{ type: 'text', text: OUT_OF_STEPS_NOTE }] });
    const step = { id: uid('stp'), text: '', thinking: '', toolCalls: [], serverTools: [], citations: [], notices: [], startedAt: now() };
    msg.steps.push(step);
    this.setPhase(threadId, 'thinking');
    let result;
    try {
      result = await app.providers.chat({
        cfg,
        system: msg.turn.system,
        messages: history,
        tools,
        reasoningEffort: agent.effort || app.settings.defaults?.effort || undefined,
        maxTokens: agent.maxTokens || undefined,
        signal,
        onEvent: (e) => {
          if (e.type === 'text' || e.type === 'thinking') this.onStreamEvent(msg, step, e);
        },
      });
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw err;
      // The work stands; only the summary is missing.
      console.warn('out-of-steps summary failed', err);
      msg.steps.splice(msg.steps.indexOf(step), 1);
      return;
    }
    if (signal.aborted) throw abortError(signal);
    step.text = result.text;
    step.endedAt = now();
    step.provider = cfg.provider.id;
    step.usage = result.usage;
    step.model = result.model;
    app.recordUsage(cfg.provider.id, result.model || cfg.model, result.usage);
    if (!step.text) msg.steps.splice(msg.steps.indexOf(step), 1);
    await app.saveMessage(msg);
  }

  /**
   * Ends a turn a new message cut short (interrupt), not as stopped: what it
   * wrote stays; a step it was still writing loses its half-made tool calls;
   * tools that hadn't finished say so, for the next turn to pick up from. The
   * chat stays busy: the next turn answers and wraps up (finishThread, afterTurn).
   */
  async cutShort(msg) {
    endUnfinished(msg, () => 'Interrupted by a new message from the user before this finished, so it may not have happened. Check before doing it again.');
    msg.status = 'done';
    await this.app.saveMessage(msg);
    return { status: 'done', text: finalText(msg), messageId: msg.id };
  }

  /**
   * Ends a turn Stop cut off (stop) as stopped, the same way: what it wrote
   * stays, and its tools say whether they were running or never ran, so the
   * bot can check and carry on when asked to (STOPPED_NOTE). A tool call
   * carried over from a paused turn (`carriedFrom`) is ended there too.
   */
  async settleStopped(threadId, msg, agent, carriedFrom = null) {
    const note = (c) => {
      if (c.pending) {
        c.dismissed = true; // a question it had just asked: its card goes
        return 'The user stopped the task before answering this.';
      }
      return c.startedAt ? STOPPED_RUNNING : STOPPED_BEFORE;
    };
    if (carriedFrom && carriedFrom !== msg && carriedFrom.steps.some((s) => (s.toolCalls || []).some((c) => !c.result))) {
      endUnfinished(carriedFrom, note);
      await this.app.saveMessage(carriedFrom);
    }
    endUnfinished(msg, note);
    msg.status = 'stopped';
    msg.error = null;
    await this.app.saveMessage(msg);
    await this.finishThread(threadId, msg, agent);
    return { status: 'stopped', text: finalText(msg), messageId: msg.id };
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
      ? { kind: 'waiting', ...said(phrase('Waiting for you: {question}', { question: call.pending.question })) }
      : { kind: 'permission', ...said(phrase('Permission required: {action}', { action: call?.approval?.say || call?.approval?.summary || call?.name })) };
    await app.updateThread(threadId, { status: 'waiting', preview: { ...preview, authorId: agent?.id, at: now() }, unread: !app.isViewing(threadId) || app.hidden() });
    app.notify(agent, preview.text, threadId, preview.say);
    return { status: 'waiting', text: finalText(waitingMsg), messageId: waitingMsg.id };
  }

  async finishThread(threadId, msg, agent) {
    const app = this.app;
    const text = finalText(msg);
    const files = msg.steps.flatMap((s) => (s.toolCalls || []).filter((c) => c.display?.kind === 'file'));
    let preview;
    const reply = truncate(text.replace(/\s+/g, ' '), 140);
    if (msg.status === 'error') preview = { kind: 'error', ...said(phrase('Error: {error}', { error: truncate(msg.error || '', 80) })) };
    else if (files.length && !text) preview = { kind: 'file', ...said(phrase('Sent {n} {things}', { n: files.length, things: fileNoun(files) })) };
    else if (!reply && msg.status === 'stopped') preview = { kind: 'normal', ...said(phrase('Stopped')) };
    else preview = { kind: 'normal', text: reply };
    const thread = app.getThread(threadId);
    const viewing = app.isViewing(threadId) && !app.hidden();
    await app.updateThread(threadId, {
      status: 'idle',
      preview: { ...preview, authorId: agent.id, at: now() },
      unread: thread?.kind === 'agents' ? false : (viewing ? false : true),
    });
    if (thread?.kind !== 'agents' && !viewing && msg.status === 'done' && (text || files.length)) app.notify(agent, preview.text, threadId, preview.say);
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
      if (signal.aborted) throw abortError(signal);
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
      // The English, and the phrase the app shows translated (`say`).
      const label = spoken(safeLabel(tool, args), tool.name);
      call.label = label.text;
      if (label.say) call.say = label.say;
      else delete call.say;
      const risk = typeof tool.risk === 'function' ? tool.risk(args) : tool.risk || 'low';
      const turnApproved = tool.approvalScope === 'turn' && (msg.turn?.approved || []).includes(tool.name);
      // `alwaysAsk`: can't be undone (deleting a repository, or email for good), so it asks whatever Auto-review and Always allow say.
      const alwaysAsk = typeof tool.alwaysAsk === 'function' ? !!tool.alwaysAsk(args) : !!tool.alwaysAsk;
      const needsReview = alwaysAsk || (risk === 'high' && app.settings.askFirst === true && !agent.alwaysAllow?.[tool.name] && !turnApproved);
      if (needsReview && call.approval?.status !== 'approved') {
        let summary = tool.approval ? tool.approval(args, { app, agent }) : call.say || call.label;
        // `preview`: what the call would do, looked up first (which emails a
        // delete reaches), to ask with. The approved call does exactly that
        // (`prepared`); with nothing to do, it finishes without asking.
        if (tool.preview) {
          let seen;
          try {
            seen = await untilAborted(tool.preview(args, { app, agent, thread, signal }), signal);
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
        const asked = spoken(summary, call.label);
        call.approval = { status: 'pending', summary: asked.text, ...(asked.say ? { say: asked.say } : {}), requestedAt: now() };
        return 'paused';
      }
      if (signal.aborted) throw abortError(signal);
      call.status = 'running';
      call.startedAt = now();
      app.touchMessage(msg);
      let res;
      try {
        // A tool that doesn't listen for the signal can't hold a stop or a new
        // message up: the turn moves on, and what it returns later is dropped.
        res = await untilAborted(tool.run(call.prepared || args, {
          app, agent, thread, message: msg, callId: call.id, signal, depth, runtime: this,
          progress: (text) => {
            call.progress = text;
            app.touchMessage(msg);
          },
        }), signal);
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
        app.logActivity(agent.id, { type: 'tool', title: call.say || call.label, detail: truncate(String(call.result.content || ''), 300), isError: !!res?.isError, threadId: thread.id });
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
      // Stopped meanwhile: no asking for permission or an answer after all.
      if (signal.aborted) throw abortError(signal);
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

    const lastFromUser = [...visible].reverse().find((m) => m.authorType === 'user');
    // This bot's reply just before the newest message was stopped: it hears so,
    // to pick the task back up when asked to.
    const stoppedBefore = !!lastFromUser && [...visible].reverse().find((m) => m.seq < lastFromUser.seq && m.authorId === agent.id)?.status === 'stopped';
    for (const m of visible) {
      if (m.authorType === 'system') {
        if (m.forModel) out.push({ role: 'user', parts: [{ type: 'text', text: messageText(m) }] });
        continue;
      }
      if (m.authorType === 'user') {
        const parts = await app.partsForModel(m, agent);
        const ctx = m.contexts?.[agent.id];
        if (group && parts[0]?.type === 'text') parts[0] = { ...parts[0], text: `[${userName}]: ${parts[0].text}` };
        const note = m !== lastFromUser ? [] : [
          { type: 'text', text: CONTENT_NOTE },
          { type: 'text', text: SELF_NOTE },
          ...(m.interrupts ? [{ type: 'text', text: INTERRUPTED_NOTE }] : []),
          ...(stoppedBefore ? [{ type: 'text', text: STOPPED_NOTE }] : []),
        ];
        out.push({ role: 'user', parts: [...(ctx ? [{ type: 'text', text: ctx }] : []), ...note, ...parts] });
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
    const res = await this.enqueue(thread.id, (halt) => this.runTurn({ agent: to, threadId: thread.id, depth, signal, halt }));
    return { threadId: thread.id, text: res?.status === 'waiting' ? `${res.text}\n\n(${to.name} is waiting for the user's approval before continuing.)`.trim() : res?.text || '', error: res?.error, stopped: res?.status === 'stopped' };
  }

  /** delegate_task: run in the background, then deliver the result back into
   * the requester's chat. A Stop in that chat, or of the bot doing it, calls it off. */
  async delegate({ from, to, task, replyThreadId, depth = 1 }) {
    const app = this.app;
    const halt = this.haltFor(replyThreadId);
    const record = await app.saveTask({
      id: uid('task'), fromAgentId: from.id, toAgentId: to.id, task, status: 'running', createdAt: now(), replyThreadId,
    });
    (async () => {
      const res = await this.converse({
        from, to, depth, signal: halt,
        text: `[Task from ${from.name}] ${task}\n\nWork on this now with your tools. When you're done, reply with the complete result (it will be passed back to ${from.name}).`,
      });
      if (halt.aborted || res.stopped) {
        await app.saveTask({ ...record, status: 'stopped', result: res.text, error: 'Stopped by the user', completedAt: now() });
        return null;
      }
      await app.saveTask({ ...record, status: res.error && !res.text ? 'failed' : 'done', result: res.text, error: res.error, completedAt: now() });
      const delivery = await app.addMessage({
        threadId: replyThreadId, authorType: 'agent', authorId: to.id,
        parts: [{ type: 'text', text: res.text || `I couldn't finish: ${res.error || 'no result'}` }],
        delivery: { kind: 'task_result', taskId: record.id, forAgentId: from.id, task },
      });
      const replyThread = app.getThread(replyThreadId);
      if (!replyThread) return;
      const reporter = replyThread.kind === 'dm' ? app.getAgent(replyThread.agentIds[0]) : from;
      if (reporter) await this.enqueue(replyThreadId, (next) => this.runTurn({ agent: reporter, threadId: replyThreadId, depth: 0, halt: next }));
      return delivery;
    })().catch((err) => console.warn('delegated task failed', err));
    return record;
  }

  // ----- group chats ------------------------------------------------------

  async runGroup(thread, trigger, halt = this.haltFor(thread.id)) {
    const app = this.app;
    const members = thread.agentIds.map((id) => app.getAgent(id)).filter(Boolean);
    if (!members.length) return null;
    const text = messageText(trigger);
    let queue = mentionedAgents(text, members);
    if (!queue.length) {
      // "@Mentions" groups: only bots that are mentioned reply.
      if (thread.mode === 'mention') return null;
      queue = thread.mode === 'all' ? [...members] : await this.pickSpeakers(thread, members, trigger, halt);
    }
    const spoken = new Set();
    let hops = 0;
    let last = null;
    // A Stop ends the round: nobody else speaks.
    while (queue.length && hops < GROUP_MAX_HOPS && !halt.aborted) {
      const agent = queue.shift();
      hops++;
      const res = await this.runTurn({ agent, threadId: thread.id, halt });
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
  async pickSpeakers(thread, members, trigger, signal) {
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
        signal,
      });
      const names = extractJson(out)?.speakers || [];
      const picked = names.map((n) => members.find((a) => normalizeName(a.name) === normalizeName(n))).filter(Boolean);
      if (picked.length) return [...new Set(picked)];
    } catch (err) {
      if (!signal?.aborted) console.warn('speaker selection failed; everyone answers', err);
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
    return this.enqueue(thread.id, (halt) => this.runTurn({ agent, threadId: thread.id, routine, halt }));
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
          app.logActivity(agentId, { type: 'memory', title: phrase('Memory update failed'), detail: errorMessage(err), isError: true });
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

/** `promise`, or an AbortError as soon as `signal` fires (what it was doing
 * carries on; its outcome is dropped). */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError(signal));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** The error a fired signal ends the work with. */
function abortError(signal) {
  return isAbort(signal.reason) ? signal.reason : new DOMException('Stopped', 'AbortError');
}

/**
 * Wraps up a reply that was cut off (cutShort, settleStopped): a step it was
 * still writing loses its half-made tool calls (never sent in full), tools
 * that hadn't finished get `note(call)` as their result, and steps left with
 * nothing to show go.
 */
function endUnfinished(msg, note) {
  const last = msg.steps[msg.steps.length - 1];
  if (last && !last.endedAt) {
    last.endedAt = now();
    last.toolCalls = [];
    last.serverTools = (last.serverTools || []).filter((st) => st.status !== 'running');
  }
  for (const step of msg.steps) {
    for (const c of step.toolCalls || []) {
      if (c.result) continue;
      c.status = 'error';
      c.result = { content: note(c), isError: true };
    }
  }
  msg.steps = msg.steps.filter((s) => s.text || s.toolCalls?.length || s.serverTools?.length || s.notices?.length);
}

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

/** A tool's label for a call: plain text, or a phrase (src/core/i18n.js). */
function safeLabel(tool, args) {
  try {
    return typeof tool.label === 'function' ? tool.label(args) : tool.label || tool.name;
  } catch {
    return tool.name;
  }
}

/** A preview's English, and the phrase to show it translated. */
function said(p) {
  const { text, say } = spoken(p);
  return { text, say };
}

function fileNoun(files) {
  const exts = new Set(files.map((f) => (f.display?.name || '').split('.').pop().toLowerCase()));
  const many = files.length > 1;
  switch (exts.size === 1 ? [...exts][0] : '') {
    case 'md': return many ? phrase('Markdown files') : phrase('Markdown file');
    case 'csv': return many ? phrase('CSV files') : phrase('CSV file');
    case 'pdf': return many ? phrase('PDFs') : phrase('PDF');
    case 'png': case 'jpg': return many ? phrase('images') : phrase('image');
    case 'json': return many ? phrase('JSON files') : phrase('JSON file');
    case 'html': return many ? phrase('HTML files') : phrase('HTML file');
    case 'txt': return many ? phrase('text files') : phrase('text file');
    case 'py': return many ? phrase('Python files') : phrase('Python file');
    default: return many ? phrase('files') : phrase('file');
  }
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
