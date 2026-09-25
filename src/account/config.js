// Holly Bot's backend and site, shared by the app (src/account/account.js) and
// Holly Computer (computer/src/account.mjs).

export const CONVEX_URL = 'https://impressive-ferret-800.convex.cloud';
export const SITE = 'https://xgamer791.github.io/holly-bot/';

/** Holly Bot's AI (convex/ai.ts): DeepSeek on Holly Bot's key, paid for with
 * the account's credits, at the backend's HTTP address. */
export const AI_URL = `${CONVEX_URL.replace(/\.convex\.cloud$/, '.convex.site')}/ai`;
