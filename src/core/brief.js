import { truncate } from './util.js';

// A bot's briefing: when the user says what a bot's job is (its description,
// in their own words, as they create it or later in its profile), Holly Bot's
// AI reads it and writes the bot a briefing: what its role is, what it does,
// how it works, what to keep an eye on and what to ask first. The bot has it
// in view from then on (src/core/prompts.js Your job). App.briefSoon makes it,
// once for each version of the job.

export const BRIEF_PROMPT = `You brief a new AI bot on its job. The bot is one of the user's personal bots in Holly Bot, a phone app where the user chats with their bots. Read the job as the user wrote it and write the bot's briefing: what it needs to know to do this job well from its first message.

Write to the bot, in second person, in English, in a few short parts:
- Your role: one or two sentences on what it's for.
- What you do: its main responsibilities, 3 to 6 short bullets.
- How you work: its approach and standards for this job, and the kinds of help it has where they fit (web search and reading pages, the user's email and computer when they're connected, running code, keeping files, routines for what to do on a schedule or check regularly, and the user's other bots to ask or hand work to).
- Keep an eye on: what it should check on or suggest without being asked, if the job calls for it.
- Ask first: the few details it needs from the user before it can do the job well, if any.

Stay within what the user wrote: don't invent facts about the user, their business or their accounts, and where the job leaves details open, tell the bot to ask. Nothing about how the bot is built or run. Under 250 words. Output only the briefing.`;

/** What the AI reads to brief `agent`: its name, its job, and the user's
 * instructions for it, if any. */
export function briefInput(agent) {
  return [
    `The bot's name: ${agent.name}`,
    `Its job, as the user wrote it:\n${truncate(agent.description, 2000)}`,
    agent.persona?.trim() && `The user's instructions for it:\n${truncate(agent.persona.trim(), 1500)}`,
  ].filter(Boolean).join('\n\n');
}
