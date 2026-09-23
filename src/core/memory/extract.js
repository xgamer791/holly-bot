import { extractJson, truncate, isoDate } from '../util.js';
import { MEMORY_TYPES, formatMemories } from './store.js';

// Background memory work: after each exchange a (configurable) model reads the
// new messages and decides what to add/update/delete in the agent's long-term
// memory. Also: rolling conversation summaries, profile synthesis, reflections.

export function extractionPrompt({ agentName, userName }) {
  return `You maintain the long-term memory of ${agentName}, an AI agent, about its user${userName ? ` (${userName})` : ''} and their shared history.
Read the latest exchange and the related memories that already exist, then output memory operations as JSON.

Save only durable, useful information, for example:
- personal facts (name, location, job, family, pets, health notes they volunteer), preferences and dislikes
- ongoing projects, goals, plans and deadlines (include dates when given)
- decisions made, commitments the agent made, instructions about how the user wants things done
- important people, organizations and relationships in the user's life
Do NOT save: small talk, one-off questions with no lasting relevance, things the agent merely said, facts about the world the user did not express interest in, secrets like passwords or API keys.

Write each memory as one self-contained sentence in third person about the user (e.g. "User's daughter Mia starts kindergarten in September 2026."). Resolve relative dates ("tomorrow") to absolute dates using today's date.
If new information contradicts or refines an existing memory, UPDATE it (by id) instead of adding a duplicate. DELETE memories the user says are wrong or asks to forget. Prefer fewer, higher-quality memories. Importance: 1 = trivia, 5 = useful, 8+ = core identity or critical.

Respond with only JSON: {"operations":[{"op":"add","text":"...","type":"${MEMORY_TYPES.join('|')}","importance":1-10,"tags":["..."]},{"op":"update","id":"mem_...","text":"...","importance":1-10},{"op":"delete","id":"mem_...","reason":"..."}]}
Return {"operations":[]} when nothing is worth remembering.`;
}

export function extractionInput({ exchange, related, today = isoDate() }) {
  const lines = exchange.map((m) => `${m.speaker}: ${truncate(m.text, 4000)}`).join('\n\n');
  return `Today's date: ${today}

Existing related memories:
${related.length ? formatMemories(related) : '(none)'}

Latest exchange:
${lines}`;
}

/** Validate and normalize model output into a clean list of operations. */
export function parseOperations(text, knownIds = new Set()) {
  const data = extractJson(text);
  const ops = Array.isArray(data) ? data : Array.isArray(data?.operations) ? data.operations : [];
  const out = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const kind = String(op.op || op.action || '').toLowerCase();
    if (kind === 'add' && typeof op.text === 'string' && op.text.trim().length > 3) {
      out.push({
        op: 'add',
        text: op.text.trim(),
        type: MEMORY_TYPES.includes(op.type) ? op.type : 'fact',
        importance: clampImportance(op.importance),
        tags: Array.isArray(op.tags) ? op.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
      });
    } else if (kind === 'update' && knownIds.has(op.id) && typeof op.text === 'string' && op.text.trim()) {
      out.push({ op: 'update', id: op.id, text: op.text.trim(), importance: op.importance != null ? clampImportance(op.importance) : undefined });
    } else if (kind === 'delete' && knownIds.has(op.id)) {
      out.push({ op: 'delete', id: op.id, reason: String(op.reason || '') });
    }
  }
  return out.slice(0, 20);
}

function clampImportance(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 5;
}

/**
 * Run extraction for one exchange and apply it.
 * @param {object} p
 * @param {(req: {system: string, prompt: string, json?: boolean, maxTokens?: number}) => Promise<string>} p.llm
 * @param {import('./store.js').MemoryStore} p.store
 */
export async function extractAndApply({ llm, store, agentId, agentName, userName, exchange, source, signal }) {
  const query = exchange.map((m) => m.text).join('\n').slice(-3000);
  const related = (await store.search(agentId, query, { limit: 12, touch: false, minScore: 0.05 }));
  const knownIds = new Set(related.map((r) => r.memory.id));
  const raw = await llm({
    system: extractionPrompt({ agentName, userName }),
    prompt: extractionInput({ exchange, related }),
    json: true,
    maxTokens: 2000,
    signal,
  });
  const ops = parseOperations(raw, knownIds);
  const applied = [];
  for (const op of ops) {
    try {
      if (op.op === 'add') {
        const { memory, action } = await store.add(agentId, { ...op, source: { ...source, kind: 'auto' } });
        applied.push({ op: action === 'merged' ? 'update' : 'add', memory });
      } else if (op.op === 'update') {
        const patch = { text: op.text };
        if (op.importance != null) patch.importance = op.importance;
        applied.push({ op: 'update', memory: await store.update(op.id, patch) });
      } else if (op.op === 'delete') {
        const m = await store.get(op.id);
        if (m && !m.pinned) {
          await store.remove(op.id);
          applied.push({ op: 'delete', memory: m });
        }
      }
    } catch (err) {
      console.warn('memory op failed', op, err);
    }
  }
  return applied;
}

export function summaryPrompt(agentName) {
  return `You compress conversation history for ${agentName}, an AI agent, so it can keep talking with full context after old messages leave its context window.
Write an updated running summary that merges the previous summary with the new messages. Keep: who said what that matters, the user's goals and requests, decisions, facts learned, open questions, promises and pending tasks, names, numbers, links and file names. Drop greetings and filler. Use compact bullet points grouped under short headings. Write in past tense. Max ~600 words.`;
}

export async function summarizeHistory({ llm, agentName, previousSummary, messages, signal }) {
  const transcript = messages.map((m) => `${m.speaker}: ${truncate(m.text, 3000)}`).join('\n\n');
  const prompt = `${previousSummary ? `Previous summary:\n${previousSummary}\n\n` : ''}New messages to fold in:\n${transcript}\n\nWrite the updated summary.`;
  const out = await llm({ system: summaryPrompt(agentName), prompt, maxTokens: 1500, signal });
  return out.trim();
}

export function profilePrompt(agentName) {
  return `You maintain the "human" core-memory block of ${agentName}, an AI agent: a compact profile of the user that is always visible to the agent.
Rewrite the profile from the current profile and the most important memories. Keep it under 180 words, in short "Key: value" lines or terse bullets (name, location/timezone, work, people, preferences, current projects/goals, how they like the agent to behave). Only include information supported by the inputs. Output only the profile text.`;
}

export async function synthesizeProfile({ llm, agentName, currentProfile, memories, signal }) {
  const prompt = `Current profile:\n${currentProfile || '(empty)'}\n\nImportant memories:\n${formatMemories(memories, { withIds: false })}`;
  return (await llm({ system: profilePrompt(agentName), prompt, maxTokens: 600, signal })).trim();
}

export function reflectionPrompt(agentName) {
  return `You help ${agentName}, an AI agent, reflect on what it knows about its user. From the memories below, infer up to 3 higher-level insights that would help it be more useful (patterns, underlying goals, preferences implied across several memories). Each insight must be supported by at least two memories. Respond with JSON: {"insights":[{"text":"...","importance":1-10}]} or {"insights":[]}.`;
}

export async function reflect({ llm, agentName, memories, signal }) {
  const raw = await llm({
    system: reflectionPrompt(agentName),
    prompt: formatMemories(memories, { withIds: false }),
    json: true,
    maxTokens: 800,
    signal,
  });
  const data = extractJson(raw);
  const list = Array.isArray(data?.insights) ? data.insights : [];
  return list
    .filter((i) => typeof i?.text === 'string' && i.text.trim().length > 10)
    .slice(0, 3)
    .map((i) => ({ text: i.text.trim(), importance: clampImportance(i.importance ?? 6) }));
}
