// Shared provider helpers.

export class ProviderError extends Error {
  constructor(message, { status, provider, code, retryable } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.code = code;
    this.retryable = retryable ?? (status === 429 || status === 408 || (status >= 500 && status < 600));
  }

  static async fromResponse(res, provider) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        detail = j.error?.message || j.error?.msg || j.message || j.detail || (typeof j.error === 'string' ? j.error : '') || text;
      } catch {
        detail = text;
      }
    } catch { /* ignore */ }
    detail = String(detail || res.statusText || '').slice(0, 600);
    const hint = res.status === 401 || res.status === 403
      ? 'Check the API key in Settings → API keys.'
      : res.status === 404 ? 'The model or endpoint was not found — pick another model.'
        : res.status === 429 ? 'Rate limited or out of credits — wait a bit or check your plan.'
          : '';
    return new ProviderError(`${provider || 'Provider'} error ${res.status}: ${detail}${hint ? ` (${hint})` : ''}`, { status: res.status, provider });
  }
}

/** Plain-text rendering of a neutral tool result for providers that only accept strings. */
export function toolResultText(r) {
  const base = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
  return r.isError ? `Error: ${base}` : base;
}

/** Friendly explanation for network failures that are usually CORS / connectivity related. */
export function explainFetchError(err, providerLabel, baseURL) {
  if (err?.name === 'AbortError') return err;
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) {
    const e = new ProviderError(
      `Could not reach ${providerLabel} (${baseURL}). This is usually a network problem, a wrong base URL, or the provider blocking direct browser requests (CORS). `
      + 'Try another provider, OpenRouter, or set a CORS proxy URL for this provider in Settings.',
      { provider: providerLabel, retryable: true },
    );
    e.cause = err;
    return e;
  }
  return err;
}
