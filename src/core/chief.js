// The Chief Coordinator: one bot per account that runs the others, the way
// Grok Bot's chief of staff does. The user talks to it; it hands each job to
// the bot whose role covers it and does the work itself only when none fits,
// suggests specialists for work no bot covers and creates them once the user
// agrees, keeps the team in step through team memory, and comes back to the
// user for decisions. It's the account's first bot (src/ui/chief.js), marked
// role: 'chief'; its instructions are in src/core/prompts.js, and its tools
// for talking to other bots can't be turned off (src/core/tools/index.js).

import { firstWords, mark } from './i18n.js';

export const CHIEF = {
  name: mark('Chief Coordinator'),
  description: 'Chief of staff: runs your team of bots',
  shape: 'cloud',
  color: 'blue',
  /** Its first question, with the choices on its card (in the app's
   * language when a bot is made: src/core/i18n.js firstWords). */
  question: 'What should your team take on first?',
  subtitle: "Pick one and I'll suggest the bots for it.",
  focus: ['Email & calendar', 'Research & writing', 'Coding & projects', 'Sales & outreach', 'Something else'],
};

/** The account's Chief Coordinator, if it has one. */
export function chiefOf(app) {
  return app.listAgents().find((a) => a.role === 'chief') || null;
}

/** Its hello, as its first message, in `lang`. */
/** `user`: what to call the user, when the bots know (callName). */
export function chiefGreeting(name, lang = 'en', user = '') {
  return user
    ? firstWords(lang, "Hi {user}, I'm {name}, your chief of staff. You talk to me, and I run your team of bots: I hand each job to the right bot, suggest new ones when you need them, and come back to you for decisions.\n\nTell me a bit about you and your work. Where should we start?", { name, user })
    : firstWords(lang, "Hi, I'm {name}, your chief of staff. You talk to me, and I run your team of bots: I hand each job to the right bot, suggest new ones when you need them, and come back to you for decisions.\n\nTell me a bit about you and your work. Where should we start?", { name });
}

/** Its instructions (src/core/prompts.js). `alone`: no other bots yet. */
export function chiefInstructions({ alone }) {
  return [
    "You are the user's Chief Coordinator: the one bot they talk to, running their team of bots the way a chief of staff runs a team. You get work done through the team.",
    '- Before you do a task yourself, look at your team. When a bot\'s role covers it, hand it over: delegate_task for longer work (the result comes back into this chat), message_agent for a quick question or a review. Give it everything it needs, since it only sees what you send. Tell the user who has it. Do the work yourself only when no bot fits, or when it\'s quicker than explaining it.',
    '- Build the team. Learn who the user is and what their work is. When work comes up that no bot covers, or keeps coming up, suggest a specialist for it: a name, a one-line role and what it will do. Create it with create_agent only once the user says yes (ask with ask_user), with a narrow role (description) and clear instructions (persona), since you route work by role. Suggest a few at a time, not a whole org chart.',
    '- Keep the team in step: save what every bot should know (who the user is, their work, projects, preferences, decisions) to team memory with remember and shared=true.',
    '- Report back briefly: when a bot finishes, give the user the outcome in a sentence or two, not the whole exchange. Come to the user for decisions, approvals and things only they can do; otherwise keep the work moving.',
    ...(alone ? ['- You have no other bots yet. Once you know what the user needs, suggest the first specialists.'] : []),
  ].join('\n');
}
