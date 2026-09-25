// Higgsfield for bots, as the account that connected it (convex/connectors.ts):
// its own MCP server, with the image and video models of the person's
// Higgsfield plan, paid for with their Higgsfield credits. The server only
// takes calls from servers (a browser's gets "Forbidden origin"), so bots
// reach it through here: `tools` lists what it offers, `call` runs one. Plain
// functions over fetch, like convex/lib/github.ts. No imports.

type Fetch = typeof fetch;

/** How a call reaches Higgsfield: the connection's access token, and a stand-in fetch for tests. */
export interface HiggsfieldApi {
  token: string;
  fetch?: Fetch;
}

/** Higgsfield answered with an error; `status` is its HTTP status. */
export class HiggsfieldError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const MCP = "https://mcp.higgsfield.ai/mcp";
const USERINFO = "https://clerk.higgsfield.ai/oauth/userinfo";
const PROTOCOL = "2025-06-18";
/** Longest a call may take: a video can take minutes, and an action has ten. */
const CALL_MS = 9 * 60_000;
/** Most of one text part, and of one image, a bot gets back. */
const MAX_TEXT = 60_000;
const MAX_IMAGE = 3_000_000;

/** The Higgsfield account a token belongs to: its email, else its name. */
export async function higgsfieldAccount(api: HiggsfieldApi): Promise<string> {
  const res = await (api.fetch ?? fetch)(USERINFO, { headers: { Authorization: `Bearer ${api.token}`, Accept: "application/json" } });
  if (!res.ok) throw new HiggsfieldError(`Higgsfield couldn't say whose account this is (HTTP ${res.status}).`, res.status);
  const me: any = await res.json().catch(() => ({}));
  return String(me?.email || me?.preferred_username || me?.name || "Higgsfield account");
}

/** One JSON-RPC message to the MCP server (a request when `id` is given, else
 * a notification): its result, read from a JSON answer or an event stream. */
async function send(api: HiggsfieldApi, session: string, message: Record<string, unknown>, signal: AbortSignal): Promise<{ result: any; session: string }> {
  const res = await (api.fetch ?? fetch)(MCP, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${api.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
    signal,
  });
  const next = res.headers.get("mcp-session-id") || session;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const data = JSON.parse(text);
      detail = String(data?.error_description || data?.error?.message || data?.error || data?.detail || detail);
    } catch { /* plain text */ }
    throw new HiggsfieldError(detail || `HTTP ${res.status}`, res.status);
  }
  if (message.id === undefined) {
    await res.body?.cancel().catch(() => {});
    return { result: null, session: next };
  }
  const reply = /text\/event-stream/i.test(res.headers.get("content-type") ?? "") ? await fromStream(res, message.id) : await res.json();
  if (reply?.error) throw new Error(`Higgsfield: ${reply.error.message || JSON.stringify(reply.error)}`);
  return { result: reply?.result ?? null, session: next };
}

/** The message answering request `id` in an event stream, read as it comes
 * (the stream may carry progress before it). */
async function fromStream(res: Response, id: unknown): Promise<any> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : events.pop() ?? "";
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let message: any;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        if (message?.id === id && ("result" in message || "error" in message)) return message;
      }
      if (done) return null;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** A request to Higgsfield's MCP server, in a session of its own: initialize,
 * then the request. */
async function request(api: HiggsfieldApi, method: string, params: Record<string, unknown>): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_MS);
  try {
    const init = await send(api, "", { id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "Holly Bot", version: "1" } } }, controller.signal);
    await send(api, init.session, { method: "notifications/initialized" }, controller.signal);
    return (await send(api, init.session, { id: 2, method, params }, controller.signal)).result;
  } catch (err) {
    if (controller.signal.aborted) throw new Error("Higgsfield took too long to answer. Try again, or check on it in Higgsfield.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** What Higgsfield offers bots: its tools ({ name, title, description, inputSchema, annotations }). */
export async function listTools(api: HiggsfieldApi): Promise<unknown[]> {
  const tools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await request(api, "tools/list", cursor ? { cursor } : {});
    for (const t of result?.tools ?? []) {
      tools.push({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });
    }
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** Runs one of Higgsfield's tools: `name`, with `arguments`. Its result, with
 * long text and large images cut down to what a bot can take. */
export async function callTool(api: HiggsfieldApi, args: { name?: unknown; arguments?: unknown }): Promise<unknown> {
  const name = String(args?.name ?? "").trim();
  if (!name) throw new Error("Which Higgsfield tool? Give its name.");
  const input = args?.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments : {};
  const result = await request(api, "tools/call", { name, arguments: input });
  const content = (Array.isArray(result?.content) ? result.content : []).map((c: any) => {
    if (c?.type === "text" && typeof c.text === "string" && c.text.length > MAX_TEXT) return { ...c, text: `${c.text.slice(0, MAX_TEXT)}\n…(cut)` };
    if (c?.type === "image" && typeof c.data === "string" && c.data.length > MAX_IMAGE) return { type: "text", text: "(An image too large to pass on; its link is in the rest of the result.)" };
    return c;
  });
  return { content, ...(result?.structuredContent ? { structuredContent: result.structuredContent } : {}), isError: !!result?.isError };
}
