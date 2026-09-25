import { SHARED_ID, USER_ID, MEMORY_TYPES, formatMemories } from '../memory/store.js';
import { truncate } from '../util.js';
import { phrase } from '../i18n.js';

// Tools an agent uses to manage its own deep memory.

const CORE_LIMIT = 4000;

export const memoryTools = [
  {
    name: 'remember',
    group: 'memory',
    label: (a) => (a.about_user ? phrase('Remembered about you') : a.shared ? phrase('Saved to team memory') : phrase('Saved to memory')),
    description: 'Save a durable fact to long-term memory: user preferences, personal details, projects, goals, decisions, promises, important people. '
      + 'Write one self-contained sentence. Set about_user=true for facts about the user themself (their name and what to call them, contact details, addresses, '
      + 'likes and dislikes, tastes, hobbies, habits, the people in their life): every one of their bots shares those. Set shared=true only for other information every bot on the team should know.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory, as one self-contained sentence.' },
        type: { type: 'string', enum: MEMORY_TYPES },
        importance: { type: 'integer', minimum: 1, maximum: 10, description: '1 = trivia, 5 = useful, 8+ = core/critical' },
        tags: { type: 'array', items: { type: 'string' } },
        about_user: { type: 'boolean', description: 'A fact about the user themself, for all their bots.' },
        shared: { type: 'boolean', description: 'Save to the shared team memory instead of your private memory.' },
      },
      required: ['text'],
    },
    async run(args, ctx) {
      if (args.about_user && ctx.app.settings.memory?.learnUser === false) {
        return { content: 'Not saved: the user asked their bots not to learn about them. If they say it\'s fine again, it will be.', isError: true };
      }
      const owner = args.about_user ? USER_ID : args.shared ? SHARED_ID : ctx.agent.id;
      const { memory, action } = await ctx.app.memory.add(owner, {
        text: args.text,
        type: args.type,
        importance: args.importance ?? 6,
        tags: args.tags || [],
        source: { threadId: ctx.thread.id, messageId: ctx.message.id, kind: 'tool' },
      });
      return {
        content: `${action === 'merged' ? 'Updated existing memory' : 'Saved memory'} ${memory.id}.`,
        display: { kind: 'memory', op: action === 'merged' ? 'update' : 'add', text: memory.text, shared: !!args.shared && !args.about_user, about: !!args.about_user },
      };
    },
  },
  {
    name: 'recall',
    group: 'memory',
    label: (a) => phrase('Searched memory for “{query}”', { query: truncate(a.query || '', 40) }),
    description: 'Search your long-term memory (with the shared team memory, and what all the bots know about the user) for facts related to a query. Use different keywords if the first search misses.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const res = await ctx.app.memory.search(ctx.agent.id, args.query, { limit: args.limit || 10, includeShared: true, includeUser: true, minScore: 0.05 });
      return {
        content: res.length ? formatMemories(res) : 'No matching memories.',
        display: { kind: 'memory_search', count: res.length },
      };
    },
  },
  {
    name: 'update_memory',
    group: 'memory',
    label: () => phrase('Updated a memory'),
    description: 'Rewrite an existing memory (by id) when information changed or was refined.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        importance: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['id', 'text'],
    },
    async run(args, ctx) {
      const m = await ctx.app.memory.get(args.id);
      if (!m || ![ctx.agent.id, SHARED_ID, USER_ID].includes(m.agentId)) return { content: `No memory ${args.id} found.`, isError: true };
      const next = await ctx.app.memory.update(args.id, { text: args.text, ...(args.importance ? { importance: args.importance } : {}) });
      return { content: `Updated ${next.id}.`, display: { kind: 'memory', op: 'update', text: next.text, about: m.agentId === USER_ID } };
    },
  },
  {
    name: 'forget',
    group: 'memory',
    label: () => phrase('Forgot a memory'),
    description: 'Delete a memory (by id) that is wrong, outdated, or that the user asked you to forget.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, reason: { type: 'string' } },
      required: ['id'],
    },
    async run(args, ctx) {
      const m = await ctx.app.memory.get(args.id);
      if (!m || ![ctx.agent.id, SHARED_ID, USER_ID].includes(m.agentId)) return { content: `No memory ${args.id} found.`, isError: true };
      await ctx.app.memory.remove(args.id);
      return { content: `Deleted ${args.id}.`, display: { kind: 'memory', op: 'delete', text: m.text, about: m.agentId === USER_ID } };
    },
  },
  {
    name: 'core_memory',
    group: 'memory',
    label: (a) => phrase('Updated core memory ({block})', { block: a.block }),
    description: 'Edit your always-visible core memory. Blocks: "persona" (who you are, your personality and role), "human" (key facts about the user), "notes" (current goals, ongoing tasks, reminders to self). '
      + 'Operations: append (add text), replace (swap old_text for text), rewrite (replace the whole block). Keep blocks concise.',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', enum: ['persona', 'human', 'notes'] },
        operation: { type: 'string', enum: ['append', 'replace', 'rewrite'] },
        text: { type: 'string' },
        old_text: { type: 'string', description: 'For replace: the exact text to replace.' },
      },
      required: ['block', 'operation', 'text'],
    },
    async run(args, ctx) {
      const agent = ctx.app.getAgent(ctx.agent.id);
      const core = { persona: '', human: '', notes: '', ...(agent.core || {}) };
      const cur = core[args.block] ?? '';
      let next;
      if (args.operation === 'append') next = cur ? `${cur}\n${args.text}` : args.text;
      else if (args.operation === 'replace') {
        if (!args.old_text || !cur.includes(args.old_text)) return { content: 'old_text not found in the block; nothing changed.', isError: true };
        next = cur.replace(args.old_text, args.text);
      } else next = args.text;
      if (next.length > CORE_LIMIT) return { content: `Block would be ${next.length} chars; limit is ${CORE_LIMIT}. Condense it (use rewrite).`, isError: true };
      await ctx.app.updateAgent(agent.id, { core: { ...core, [args.block]: next } });
      return { content: `Core memory "${args.block}" updated (takes effect from your next reply).`, display: { kind: 'memory', op: 'core', text: `${args.block}: ${truncate(next, 160)}` } };
    },
  },
  {
    name: 'search_history',
    group: 'memory',
    label: (a) => phrase('Searched past chats for “{query}”', { query: truncate(a.query || '', 40) }),
    description: 'Full-text search over all your past conversations (with the user, other bots and groups), including messages older than your context window.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
      required: ['query'],
    },
    async run(args, ctx) {
      const hits = await ctx.app.searchHistory(ctx.agent.id, args.query, { limit: args.limit || 8 });
      if (!hits.length) return { content: 'No matching messages.' };
      return {
        content: hits.map((h) => `[${new Date(h.createdAt).toISOString().slice(0, 16).replace('T', ' ')}] ${h.threadTitle} — ${h.speaker}: ${truncate(h.text, 500)}`).join('\n'),
        display: { kind: 'history_search', count: hits.length },
      };
    },
  },
];
