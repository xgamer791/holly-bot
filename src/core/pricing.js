// Rough public list prices (USD per 1M tokens) for usage estimates:
// [model pattern, input, output, cached input (default: 10% of input)].
// Your provider's dashboard is the source of truth.
const PRICES = [
  // DeepSeek: listed at peak; half price off-peak (see deepseekPeak).
  [/^deepseek-flash/, 0.3, 1.2, 0.006], [/^deepseek-v4-pro/, 1.32, 3.96, 0.044],
  [/^deepseek-chat/, 0.27, 1.1, 0.07], [/^deepseek-reasoner/, 0.55, 2.19, 0.14],
  [/^claude-fable-5/, 10, 50], [/^claude-opus-(5|4-[5-8])/, 5, 25], [/^claude-sonnet-5/, 2, 10],
  [/^claude-sonnet-4/, 3, 15], [/^claude-haiku-4/, 1, 5],
  [/^gpt-5-nano/, 0.05, 0.4], [/^gpt-5-mini/, 0.25, 2], [/^gpt-5/, 1.25, 10], [/^gpt-4\.1-mini/, 0.4, 1.6], [/^gpt-4\.1/, 2, 8], [/^o4-mini/, 1.1, 4.4],
  [/^grok-4-fast|^grok-4-1-fast/, 0.2, 0.5], [/^grok-code-fast/, 0.2, 1.5], [/^grok-4/, 3, 15], [/^grok-3-mini/, 0.3, 0.5], [/^grok-3/, 3, 15],
  [/^gemini-2\.5-pro/, 1.25, 10], [/^gemini-2\.5-flash-lite/, 0.1, 0.4], [/^gemini-2\.5-flash/, 0.3, 2.5],
];

/** DeepSeek peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. */
export function deepseekPeak(at = Date.now()) {
  const d = new Date(at);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** Estimated USD cost of token usage { input, output, cacheRead } for a model, at time `at`. */
export function estimateCost(model, u, at) {
  const bare = String(model || '').split('/').pop();
  const p = PRICES.find(([re]) => re.test(bare));
  if (!p || !u) return null;
  const [, input, output, cached = input * 0.1] = p;
  const factor = /^deepseek-/.test(bare) && at != null && !deepseekPeak(at) ? 0.5 : 1;
  const fresh = Math.max(0, (u.input || 0) - (u.cacheRead || 0));
  return ((fresh * input + (u.cacheRead || 0) * cached + (u.output || 0) * output) / 1e6) * factor;
}

/** Total estimated spend from settings.usage (recorded per call where available). */
export function totalCost(settings) {
  let sum = 0;
  let known = false;
  for (const [key, u] of Object.entries(settings.usage?.byModel || {})) {
    const c = u.cost != null ? u.cost : estimateCost(key.split(':').slice(1).join(':'), u);
    if (c != null) {
      sum += c;
      known = true;
    }
  }
  return known ? sum : null;
}
