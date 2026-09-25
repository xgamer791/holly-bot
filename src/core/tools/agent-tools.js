import { truncate } from '../util.js';
import { SHAPE_KEYS_CORE, COLOR_KEYS_CORE } from '../constants.js';
import { phrase } from '../i18n.js';

// Tools for talking to the user (question cards, files) and to other bots.

export const MAX_AGENT_DEPTH = 3;

export const interactionTools = [
  {
    name: 'ask_user',
    group: 'core',
    label: (a) => truncate(a.question || 'Question', 60),
    description: 'Ask the user a multiple-choice question shown as a tappable card; they can also answer in their own words. '
      + 'Use it when you need a decision or preference and there are 2–5 clear options (keep options short, 1–5 words). Your turn pauses until they answer.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Short question title, e.g. "What should I focus on first?"' },
        subtitle: { type: 'string', description: 'Optional one-line hint under the title.' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 },
        allow_multiple: { type: 'boolean', description: 'Let the user pick more than one option.' },
      },
      required: ['question', 'options'],
    },
    async run(args) {
      const options = (args.options || []).map((o) => String(o).trim()).filter(Boolean).slice(0, 6);
      if (options.length < 2) return { content: 'ask_user needs at least 2 options.', isError: true };
      return { pending: { kind: 'question', question: args.question, subtitle: args.subtitle || '', options, multiple: !!args.allow_multiple } };
    },
  },
  {
    name: 'send_file',
    group: 'core',
    label: (a) => {
      const file = a.path?.split('/').pop();
      return file ? phrase('Sent {file}', { file }) : phrase('Sent a file');
    },
    description: 'Send one of your files (from your files/computer drive) to the user as an attachment card they can open, preview or download.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, note: { type: 'string' } },
      required: ['path'],
    },
    async run(args, ctx) {
      const file = await ctx.app.files.get(ctx.agent.id, args.path);
      if (!file) return { content: `No file at ${args.path}. Use list_files to see your files.`, isError: true };
      return {
        content: `Sent ${file.path} (${file.size} bytes) to the user.`,
        display: { kind: 'file', fileId: file.id, name: file.path.split('/').pop(), path: file.path, size: file.size, mime: file.mime, note: args.note || '' },
      };
    },
  },
];

export const agentTools = [
  {
    name: 'list_agents',
    group: 'agents',
    label: () => phrase('Checked the team'),
    description: 'List the other bots you can talk to, with their roles and whether they are busy.',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const others = ctx.app.listAgents().filter((a) => a.id !== ctx.agent.id);
      if (!others.length) {
        return {
          content: ctx.agent.role === 'chief'
            ? 'You are the only bot right now. Suggest specialists for the user\'s work, and create them with create_agent once they agree.'
            : 'You are the only bot right now. The user can create more with the + button.',
        };
      }
      return {
        content: others.map((a) => `- ${a.name}${a.role === 'chief' ? ' (the Chief Coordinator, who runs the team)' : ''}${a.description ? ` — ${a.description}` : ''}${ctx.runtime.isAgentBusy(a.id) ? ' (busy)' : ''}`).join('\n'),
      };
    },
  },
  {
    name: 'message_agent',
    group: 'agents',
    label: (a) => phrase('Messaged {bot}', { bot: a.agent }),
    description: 'Send a message to another bot and wait for its reply. It answers with its own memory, tools and personality, and only sees what you send, so include the needed context. '
      + 'Use for questions, opinions, reviews and quick tasks. For long work use delegate_task instead.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name of the other bot.' },
        message: { type: 'string' },
      },
      required: ['agent', 'message'],
    },
    async run(args, ctx) {
      const target = ctx.app.findAgent(args.agent);
      if (!target) return { content: `No bot named "${args.agent}". Available: ${namesExcept(ctx)}.`, isError: true };
      if (target.id === ctx.agent.id) return { content: 'That is you. Message a different bot.', isError: true };
      if (ctx.depth >= MAX_AGENT_DEPTH) {
        return { content: `Conversation chain limit reached (${MAX_AGENT_DEPTH} bots deep). Answer with what you have.`, isError: true };
      }
      const reply = await ctx.runtime.converse({
        from: ctx.agent, to: target, text: args.message, depth: ctx.depth + 1, signal: ctx.signal,
      });
      return {
        content: reply.text ? `${target.name} replied:\n${reply.text}` : `${target.name} did not reply${reply.error ? ` (${reply.error})` : ''}.`,
        isError: !reply.text,
        display: { kind: 'agent_chat', agentId: target.id, threadId: reply.threadId, message: args.message, reply: reply.text || '', error: reply.error || '' },
      };
    },
  },
  {
    name: 'delegate_task',
    group: 'agents',
    label: (a) => phrase('Delegated to {bot}', { bot: a.agent }),
    description: 'Hand off a longer task to another bot. It works in the background with its own tools; when it finishes, the result is delivered back into this chat and you will continue from there. Returns immediately.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        task: { type: 'string', description: 'Clear instructions, expected output and any context needed.' },
      },
      required: ['agent', 'task'],
    },
    async run(args, ctx) {
      const target = ctx.app.findAgent(args.agent);
      if (!target) return { content: `No bot named "${args.agent}". Available: ${namesExcept(ctx)}.`, isError: true };
      if (target.id === ctx.agent.id) return { content: 'You cannot delegate to yourself.', isError: true };
      const task = await ctx.runtime.delegate({ from: ctx.agent, to: target, task: args.task, replyThreadId: ctx.thread.id, depth: ctx.depth + 1 });
      return {
        content: `Task ${task.id} handed to ${target.name}. You will receive the result in this chat when it is done; tell the user it's in progress.`,
        display: { kind: 'delegation', agentId: target.id, taskId: task.id, task: args.task },
      };
    },
  },
  {
    name: 'create_agent',
    group: 'agents',
    risk: 'high',
    label: (a) => phrase('Create bot “{name}”', { name: a.name }),
    description: 'Create a new bot (a teammate with its own name, look, personality and memory). Only do this when the user asks for a new bot, or agrees to one you suggested.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string', description: 'One-line role, e.g. "Research specialist".' },
        persona: { type: 'string', description: 'Personality and instructions for the new bot.' },
        shape: { type: 'string', enum: SHAPE_KEYS_CORE },
        color: { type: 'string', enum: COLOR_KEYS_CORE },
      },
      required: ['name'],
    },
    approval: (a) => `Create a new bot named “${a.name}”${a.description ? ` (${a.description})` : ''}`,
    async run(args, ctx) {
      if (ctx.app.findAgent(args.name)) return { content: `A bot named ${args.name} already exists.`, isError: true };
      const agent = await ctx.app.createAgent({
        name: args.name,
        description: args.description || '',
        persona: args.persona || '',
        shape: SHAPE_KEYS_CORE.includes(args.shape) ? args.shape : undefined,
        color: COLOR_KEYS_CORE.includes(args.color) ? args.color : undefined,
        provider: ctx.agent.provider,
        model: ctx.agent.model,
        createdBy: ctx.agent.id,
      });
      return { content: `Created ${agent.name}.`, display: { kind: 'agent_created', agentId: agent.id } };
    },
  },
];

function namesExcept(ctx) {
  return ctx.app.listAgents().filter((a) => a.id !== ctx.agent.id).map((a) => a.name).join(', ') || 'none';
}
