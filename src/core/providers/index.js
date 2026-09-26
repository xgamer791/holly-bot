import { chatCompletion, listChatModels, chatEmbeddings } from './openai-chat.js';
import { anthropicMessage, listAnthropicModels, claudeTraits } from './anthropic.js';
import { responsesCall } from './openai-responses.js';
import { ProviderError, explainFetchError } from './common.js';
import { AI_URL } from '../../account/config.js';

// The AI bots think with. It's Holli Bot's own: DeepSeek, which Holli Bot's
// server calls on its key, paid for with the account's monthly credits
// (convex/ai.ts, convex/credits.ts). Requests go there with the account's
// session instead of a key. Until the server says it can run it (credits:mine
// `ready`), a DeepSeek key kept from before bots ran on credits still works.
// The other providers below aren't offered: bots run on credits only.

export const PROVIDERS = {
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'responses',
    baseURL: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai/',
    keyHint: 'xai-…',
    defaultModel: 'grok-4',
    memoryModel: 'grok-4-fast-non-reasoning',
    suggested: ['grok-4', 'grok-4-fast-reasoning', 'grok-4-fast-non-reasoning', 'grok-code-fast-1', 'grok-3-mini'],
    nativeTools: ['web_search', 'x_search'],
    image: { model: 'grok-2-image-1212', endpoint: 'images/generations', b64: true },
    reasoningEffort: false,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
    defaultModel: 'claude-opus-5',
    memoryModel: '',
    suggested: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1', 'claude-opus-4-8'],
    nativeTools: ['web_search', 'web_fetch'],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    kind: 'responses',
    baseURL: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    defaultModel: 'gpt-5',
    memoryModel: 'gpt-5-mini',
    suggested: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'o4-mini'],
    nativeTools: ['web_search'],
    image: { model: 'gpt-image-1', endpoint: 'images/generations', b64: false },
    embeddings: 'text-embedding-3-small',
    reasoningEffort: true,
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    kind: 'openai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…',
    defaultModel: 'gemini-2.5-pro',
    memoryModel: 'gemini-2.5-flash',
    suggested: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    embeddings: 'gemini-embedding-001',
    reasoningEffort: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    defaultModel: 'x-ai/grok-4',
    memoryModel: 'x-ai/grok-4-fast',
    suggested: ['x-ai/grok-4', 'x-ai/grok-4-fast', 'anthropic/claude-opus-5', 'openai/gpt-5', 'google/gemini-2.5-pro'],
    nativeTools: ['web_search'],
    headers: () => ({ 'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://holli.bot', 'X-Title': 'Holli Bot' }),
    reasoningEffort: false,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    defaultModel: 'openai/gpt-oss-120b',
    memoryModel: 'llama-3.1-8b-instant',
    suggested: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile'],
    maxTokensField: 'max_completion_tokens',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseURL: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-…',
    recommended: true,
    defaultModel: 'deepseek-flash',
    memoryModel: 'deepseek-flash',
    suggested: ['deepseek-flash', 'deepseek-v4-pro'],
    // V4.1 Flash sees images; V4 Pro is text-only (images are described by Flash for it).
    vision: (model) => !/v4-pro|reasoner/.test(model),
    // Thinking mode: reasoning_content must be replayed verbatim on every assistant turn when tools are sent.
    replayReasoning: true,
    thinkingParam: true,
    effortMap: { low: 'low', medium: 'high', high: 'high', max: 'max' },
    defaultMaxTokens: 32768,
    context: 1000000,
    balance: '/user/balance',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyHint: '',
    defaultModel: 'mistral-large-latest',
    memoryModel: 'mistral-small-latest',
    suggested: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'],
    embeddings: 'mistral-embed',
    streamUsage: false,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseURL: 'http://localhost:11434/v1',
    keyUrl: 'https://ollama.com/download',
    noKey: true,
    defaultModel: 'llama3.1',
    memoryModel: '',
    suggested: ['llama3.1', 'qwen2.5', 'gpt-oss:20b'],
  },
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    baseURL: '',
    keyUrl: '',
    defaultModel: '',
    memoryModel: '',
    suggested: [],
  },
};

export const PROVIDER_ORDER = ['deepseek', 'xai', 'anthropic', 'openai', 'google', 'openrouter', 'groq', 'mistral', 'ollama', 'custom'];

/** Everything defaults to DeepSeek V4.1 Flash. */
export const DEFAULT_PROVIDER = 'deepseek';

/** The models Holli Bot's AI runs (convex/lib/credits.ts): Flash, the default,
 * and Pro, which uses credits about four times as fast. */
export const AI_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

const CONTEXT_WINDOWS = [
  [/^deepseek-/, 1000000], [/^claude-(opus-(4-[678]|5)|sonnet-(4-6|5)|fable|mythos)/, 1000000], [/^claude-/, 200000],
  [/^gpt-5/, 400000], [/^gpt-4\.1/, 1000000], [/^o[34]/, 200000], [/^gpt-4o/, 128000],
  [/^grok-4-fast|^grok-4-1|^grok-code/, 2000000], [/^grok-4/, 256000], [/^grok-3/, 131072],
  [/^gemini-(2\.5|3)/, 1000000], [/^gemini/, 1000000], [/^mistral-(large|medium)/, 128000], [/llama|qwen|kimi|gpt-oss/, 128000],
];

/** Context window (tokens) for a model — used to size how much raw history a bot keeps. */
export function contextWindow(providerId, model = '') {
  const bare = String(model).split('/').pop();
  const hit = CONTEXT_WINDOWS.find(([re]) => re.test(bare));
  if (hit) return hit[1];
  return PROVIDERS[providerId]?.context || 128000;
}

export function supportsVision(providerId, model = '') {
  const v = PROVIDERS[providerId]?.vision;
  if (typeof v === 'function') return v(model);
  return v !== false;
}

export class ProviderHub {
  constructor(app) {
    this.app = app;
  }

  /** Whether bots run on Holli Bot's AI and the account's credits: signed in,
   * with a server that can run it. */
  onCredits() {
    return !!this.app.credits?.ready && typeof this.app.db?.sessionToken === 'function';
  }

  /** Effective config for a provider (key, base URL, proxy, headers). */
  config(id) {
    const def = PROVIDERS[id];
    if (!def) throw new ProviderError(`Unknown provider "${id}"`);
    // Holli Bot's AI: the key is the account's session, added as a request goes out (chat).
    if (id === 'deepseek' && this.onCredits()) {
      return { ...def, id, label: "Holli Bot's AI", apiKey: '', baseURL: AI_URL, headers: {}, models: [], credits: true };
    }
    const user = this.app.settings.providers?.[id] || {};
    let baseURL = (user.baseURL || def.baseURL || '').trim().replace(/\/+$/, '');
    const proxy = (user.proxy || '').trim();
    if (proxy) baseURL = proxy.includes('{url}') ? proxy.replace('{url}', baseURL) : `${proxy.replace(/\/+$/, '')}/${baseURL}`;
    return {
      ...def,
      id,
      label: def.label,
      apiKey: (user.apiKey || '').trim(),
      baseURL,
      headers: { ...(typeof def.headers === 'function' ? def.headers() : def.headers || {}), ...(user.headers || {}) },
      models: user.models || [],
    };
  }

  /** Only DeepSeek: on credits, or on a key kept from before until the server can run them. */
  isReady(id) {
    if (id !== 'deepseek') return false;
    return this.onCredits() || !!this.app.settings.providers?.deepseek?.apiKey?.trim();
  }

  readyProviders() {
    return PROVIDER_ORDER.filter((id) => this.isReady(id));
  }

  /** The model a bot uses: its own choice of Holli Bot's AI models, else the
   * app's, else Flash. A model from another provider (a bot set up before
   * bots ran on credits) counts as no choice. */
  resolve(agent, purpose = 'chat') {
    if (!this.isReady(DEFAULT_PROVIDER)) {
      const err = new ProviderError(this.app.db?.cloud
        ? "Holli Bot's AI isn't ready yet. Try again in a minute."
        : 'Link this computer to your Holli Bot account (the computer button at the top right) so your bots can use its AI.');
      err.kind = 'no_key';
      throw err;
    }
    const defaults = this.app.settings.defaults || {};
    const ours = (model) => (AI_MODELS.includes(model) ? model : '');
    const provider = this.config(DEFAULT_PROVIDER);
    let model = ours(agent?.model) || ours(defaults.model) || provider.defaultModel;
    if (purpose === 'memory') {
      const mm = agent?.memoryModel || defaults.memoryModel;
      if (mm && mm !== 'same') model = ours(mm.includes(':') ? mm.split(':').slice(1).join(':') : mm) || model;
    }
    // Free runs Flash only (convex/credits.ts): a bot set to Pro thinks with
    // Flash until the account is on a paid plan.
    if (provider.credits && this.app.credits?.plan === 'free') model = AI_MODELS[0];
    return { provider, model, purpose };
  }

  /** Server-side tools the provider will run itself for this bot. */
  serverToolsFor(cfg, agent) {
    if (agent?.tools?.web === false) return [];
    const def = PROVIDERS[cfg.provider.id];
    let tools = def?.nativeTools || [];
    if (cfg.provider.id === 'anthropic') {
      const t = claudeTraits(cfg.model);
      if (!t) tools = [];
    }
    if (cfg.provider.id === 'openai' && !/^(gpt-4\.1|gpt-4o|gpt-5|o3|o4)/.test(cfg.model)) tools = [];
    if (this.app.settings.providers?.[cfg.provider.id]?.nativeSearch === false) tools = [];
    return tools;
  }

  /** Streamed chat with tools. Returns the neutral result. On Holli Bot's AI
   * the request carries the account's session, renewed once if it's turned down. */
  async chat(opts) {
    const { provider } = opts.cfg;
    if (!provider.credits) return this.send(opts, provider);
    const session = async (force) => {
      try {
        return await this.app.db.sessionToken({ force });
      } catch {
        const err = new ProviderError('Sign in to Holli Bot again so your bots can keep using its AI.', { status: 401, provider: provider.label });
        err.kind = 'no_key';
        throw err;
      }
    };
    try {
      return await this.send(opts, { ...provider, apiKey: await session(false) });
    } catch (err) {
      if (err?.status !== 401 || err.kind === 'no_key' || opts.signal?.aborted) throw err;
      return this.send(opts, { ...provider, apiKey: await session(true) });
    }
  }

  async send({ cfg, system, messages, tools, serverTools = [], reasoningEffort, maxTokens, temperature, signal, onEvent, json, thinking, store }, provider) {
    const { model } = cfg;
    const req = {
      provider, model, system, messages, tools, serverTools, reasoningEffort, maxTokens, temperature, signal, onEvent, json, thinking,
      vision: supportsVision(provider.id, model),
    };
    try {
      if (provider.kind === 'anthropic') return await anthropicMessage(req);
      if (provider.kind === 'responses') return await responsesCall(req);
      const extraBody = {};
      if (provider.id === 'openrouter' && serverTools.includes('web_search')) extraBody.plugins = [{ id: 'web', max_results: 5 }];
      if (provider.id === 'openrouter') extraBody.usage = { include: true };
      if (provider.thinkingParam) {
        extraBody.thinking = { type: thinking === false ? 'disabled' : 'enabled' };
      }
      // A Bot Store bot (`store`: which one): Holli Bot's server adds its
      // pre-trained memory, which the app never has (convex/ai.ts).
      if (provider.credits && store) extraBody.store = store;
      // "max" is DeepSeek's (effortMap); an OpenAI-style effort tops out at "high".
      const effort = provider.effortMap ? provider.effortMap[reasoningEffort]
        : provider.reasoningEffort ? (reasoningEffort === 'max' ? 'high' : reasoningEffort) : undefined;
      let streamed = false;
      const body = {
        ...req,
        extraBody,
        reasoningEffort: thinking === false ? undefined : effort,
        maxTokens: maxTokens || provider.defaultMaxTokens,
        replayReasoning: !!provider.replayReasoning && !!tools?.length,
        onEvent: (e) => {
          streamed = true;
          onEvent?.(e);
        },
      };
      try {
        return await chatCompletion(body);
      } catch (err) {
        // Bots think at DeepSeek's max unless their profile says less: should
        // DeepSeek turn "max" down, the same request goes again at "high"
        // (a request DeepSeek turns down costs no credits).
        if (body.reasoningEffort !== 'max' || ![400, 422].includes(err?.status) || streamed || signal?.aborted) throw err;
        return await chatCompletion({ ...body, reasoningEffort: 'high' });
      }
    } catch (err) {
      if (provider.credits && err instanceof TypeError) {
        const e = new ProviderError("Couldn't reach Holli Bot's AI. Check your internet connection and try again.", { provider: provider.label, retryable: true });
        e.cause = err;
        throw e;
      }
      throw explainFetchError(err, provider.label, provider.baseURL);
    }
  }

  /**
   * The backup model to retry on after `cfg` failed with `err`, or null.
   * Not for requests that were themselves invalid (400/404/413/422) or cancelled.
   */
  backupFor(cfg, err) {
    // Bots run on Holli Bot's AI only: there's no other to fall back on.
    if (this.onCredits() || !err || err.name === 'AbortError' || err.kind === 'no_key') return null;
    if ([400, 404, 413, 422].includes(err.status)) return null;
    const b = this.app.settings.backup;
    if (!b?.provider || !this.isReady(b.provider)) return null;
    const provider = this.config(b.provider);
    const model = b.model || provider.defaultModel;
    if (b.provider === cfg.provider.id && model === cfg.model) return null;
    return { provider, model, purpose: cfg.purpose, backup: true };
  }

  /** One-shot completion for background work (memory, summaries, routing). Returns text. */
  async complete(opts) {
    const cfg = this.resolve(opts.agent, opts.purpose || 'memory');
    try {
      return await this.completeWith(cfg, opts);
    } catch (err) {
      const backup = opts.signal?.aborted ? null : this.backupFor(cfg, err);
      if (!backup) throw err;
      return this.completeWith(backup, opts);
    }
  }

  async completeWith(cfg, { system, prompt, json = false, maxTokens = 1500, signal }) {
    const isClaude = cfg.provider.kind === 'anthropic';
    const res = await this.chat({
      cfg,
      system,
      messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
      tools: [],
      serverTools: [],
      // Leave room for reasoning on models that always think; keep effort low for background jobs.
      maxTokens: isClaude ? Math.max(maxTokens, 8000) : maxTokens,
      reasoningEffort: 'low',
      thinking: cfg.provider.thinkingParam ? false : undefined,
      json: json && cfg.provider.kind === 'openai' && cfg.provider.id !== 'anthropic',
      signal,
    });
    this.app.recordUsage(cfg.provider.id, res.model || cfg.model, res.usage);
    return res.text;
  }

  async listModels(id, { signal } = {}) {
    const cfg = this.config(id);
    try {
      if (cfg.kind === 'anthropic') return await listAnthropicModels(cfg);
      return await listChatModels(cfg, signal);
    } catch (err) {
      throw explainFetchError(err, cfg.label, cfg.baseURL);
    }
  }

  /** Validate a key by listing models (free) — returns the model list. */
  async test(id) {
    const models = await this.listModels(id);
    const user = this.app.settings.providers?.[id] || {};
    await this.app.saveSettings({ providers: { ...this.app.settings.providers, [id]: { ...user, models: models.map((m) => m.id).slice(0, 400), testedAt: Date.now() } } });
    return models;
  }

  /** Account balance where the provider exposes it (DeepSeek). */
  async balance(id) {
    const def = PROVIDERS[id];
    if (!def?.balance || !this.isReady(id)) return null;
    const cfg = this.config(id);
    const res = await fetch(`${cfg.baseURL}${def.balance}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    if (!res.ok) throw await ProviderError.fromResponse(res, cfg.label);
    const data = await res.json();
    return (data.balance_infos || []).map((b) => ({ currency: b.currency, total: Number(b.total_balance), granted: Number(b.granted_balance), toppedUp: Number(b.topped_up_balance) }))
      .concat(data.is_available === false ? [{ unavailable: true }] : []);
  }

  /** A vision-capable model to describe images for text-only bots (DeepSeek Flash first). */
  visionHelper() {
    const order = ['deepseek', 'google', 'openai', 'xai', 'anthropic', 'openrouter'];
    for (const id of order) {
      if (!this.isReady(id)) continue;
      const def = PROVIDERS[id];
      const model = id === 'deepseek' ? 'deepseek-flash' : def.memoryModel || def.defaultModel;
      if (supportsVision(id, model)) return { provider: this.config(id), model, purpose: 'vision' };
    }
    return null;
  }

  /** Describe images with a vision model (for text-only bots). Returns text or null. */
  async describeImages(images, { hint = '', signal } = {}) {
    const helper = this.visionHelper();
    if (!helper || !images?.length) return null;
    const res = await this.chat({
      cfg: helper,
      system: 'You are the eyes of an AI agent that cannot see images. Describe images precisely and concisely so the agent can act on them. '
        + 'Never describe sexual content or nudity, gore or graphic violence, or drugs: where an image shows any, say only that part of it has content that can\'t be described.',
      messages: [{
        role: 'user',
        parts: [
          ...images.map((i) => ({ type: 'image', mime: i.mime, data: i.data })),
          { type: 'text', text: `${hint} Describe what is visible: windows and apps, all readable text, buttons, links, menus, input fields and their values, dialogs and errors. For every interactive element give the approximate pixel coordinates (x, y) of its center in the image so the agent can click it.` },
        ],
      }],
      tools: [],
      thinking: false,
      maxTokens: 2500,
      signal,
    });
    this.app.recordUsage(helper.provider.id, res.model || helper.model, res.usage);
    return res.text || null;
  }

  /** Embeddings backend for memory search, or null (local similarity is used then). */
  embedder() {
    const pref = this.app.settings.memory?.embeddings || 'auto';
    if (pref === 'off') return null;
    const candidates = pref === 'auto' ? ['openai', 'google', 'mistral'] : [pref.split(':')[0]];
    for (const id of candidates) {
      if (!this.isReady(id)) continue;
      const model = pref.includes(':') ? pref.split(':').slice(1).join(':') : PROVIDERS[id].embeddings;
      if (!model) continue;
      const cfg = this.config(id);
      return {
        id: `${id}:${model}`,
        embed: (texts) => chatEmbeddings(cfg, model, texts),
      };
    }
    return null;
  }

  imageProvider() {
    const order = ['xai', 'openai'];
    const pref = this.app.settings.defaults?.imageProvider;
    if (pref && this.isReady(pref) && PROVIDERS[pref]?.image) return pref;
    return order.find((id) => this.isReady(id) && PROVIDERS[id].image) || null;
  }

  async generateImage(prompt, { signal } = {}) {
    const id = this.imageProvider();
    if (!id) throw new Error('No image-capable provider key (xAI or OpenAI) is set up.');
    const cfg = this.config(id);
    const spec = PROVIDERS[id].image;
    const model = this.app.settings.providers?.[id]?.imageModel || spec.model;
    const body = { model, prompt, n: 1 };
    if (spec.b64) body.response_format = 'b64_json';
    let res;
    try {
      res = await fetch(`${cfg.baseURL}/${spec.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, ...cfg.headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw explainFetchError(err, cfg.label, cfg.baseURL);
    }
    if (!res.ok) throw await ProviderError.fromResponse(res, cfg.label);
    const data = await res.json();
    const item = data.data?.[0] || {};
    let b64 = item.b64_json;
    let mime = 'image/png';
    if (!b64 && item.url) {
      const img = await fetch(item.url, { signal });
      const blob = await img.blob();
      mime = blob.type || mime;
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      b64 = btoa(bin);
    }
    if (!b64) throw new Error('The provider returned no image.');
    if (b64.startsWith('/9j/')) mime = 'image/jpeg';
    this.app.recordUsage(id, model, { images: 1 });
    return { data: b64, mime, model, revisedPrompt: item.revised_prompt };
  }
}
