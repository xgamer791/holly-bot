// Gmail and Outlook for bots, on the mailbox the account connected
// (convex/connectors.ts). Plain functions over fetch, so the same code runs in
// Convex actions and in tests (tests/unit/connectors.test.mjs). No imports:
// the tests load this file straight into Node.

type Fetch = typeof fetch;

/** How a call reaches a service: the access token, and a stand-in fetch for tests. */
export interface Api {
  token: string;
  fetch?: Fetch;
}

/** A service answered with an error; `status` is its HTTP status. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GRAPH = "https://graph.microsoft.com/v1.0/me";

/** Most of an email's text a bot gets back (the rest is cut, and it says so). */
const MAX_BODY = 20_000;

// ----- helpers ------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function toBase64Url(text: string): string {
  return utf8ToBase64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(data: string): string {
  return new TextDecoder().decode(base64ToBytes(data));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (all, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[name.toLowerCase()] ?? all;
  });
}

/** Readable text from an HTML email: blocks become lines, tags go, links keep their address. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, "").trim();
        return text && text !== href ? `${text} (${href})` : href;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(text: string, max = MAX_BODY) {
  return text.length > max ? { text: `${text.slice(0, max)}\n\n[…cut: ${text.length - max} more characters]`, truncated: true } : { text, truncated: false };
}

function clamp(n: unknown, lo: number, hi: number, fallback: number) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/** One header line's worth: a bot can't slip extra headers (Bcc…) in through a line break. */
function oneLine(value: unknown): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

/** A header value in plain ASCII, or MIME-encoded when it isn't. */
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${utf8ToBase64(value)}?=`;
}

const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Email addresses from a list or a comma/semicolon separated string, checked. */
export function addresses(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[,;]/);
  const out: string[] = [];
  for (const raw of list) {
    const item = oneLine(raw);
    if (!item) continue;
    const bare = item.match(/<([^<>]+)>\s*$/)?.[1]?.trim() ?? item;
    if (!ADDRESS.test(bare)) throw new Error(`“${item}” isn't an email address.`);
    out.push(item.includes("<") ? item : bare);
  }
  return out;
}

async function call(api: Api, url: string, init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${api.token}`, Accept: "application/json", ...(init.headers ?? {}) };
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await (api.fetch ?? fetch)(url, { ...init, headers });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = data?.error?.message ?? data?.error_description ?? data?.message ?? (typeof data === "string" && data.slice(0, 200)) ?? "";
    throw new ApiError(message || `HTTP ${res.status}`, res.status);
  }
  return data;
}

// ----- Gmail ----------------------------------------------------------------------

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

function header(part: GmailPart | undefined, name: string): string {
  return part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function walk(part: GmailPart | undefined, visit: (p: GmailPart) => void) {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

/** The mailbox's address. */
export async function gmailProfile(api: Api) {
  const p = await call(api, `${GMAIL}/profile`);
  return { email: String(p?.emailAddress ?? "") };
}

/** Emails matching a Gmail search (from:, to:, subject:, is:unread, newer_than:7d…), newest first. */
export async function gmailSearch(api: Api, args: { query?: string; max?: number }) {
  const n = clamp(args.max, 1, 25, 10);
  const q = oneLine(args.query);
  const list = await call(api, `${GMAIL}/messages?maxResults=${n}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const ids: string[] = (list?.messages ?? []).map((m: { id: string }) => m.id);
  const wanted = ["From", "To", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
  const messages = await Promise.all(ids.map((id) => call(api, `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&${wanted}`)));
  return messages.map((m) => ({
    id: String(m.id),
    threadId: String(m.threadId ?? ""),
    from: header(m.payload, "From"),
    to: header(m.payload, "To"),
    subject: header(m.payload, "Subject"),
    date: header(m.payload, "Date"),
    snippet: decodeEntities(String(m.snippet ?? "")),
    unread: Array.isArray(m.labelIds) && m.labelIds.includes("UNREAD"),
  }));
}

/** One email: its headers, its text (plain text, or HTML made readable) and its attachments' names. */
export async function gmailRead(api: Api, args: { id: string }) {
  const id = oneLine(args.id);
  if (!id) throw new Error("Which email? Give its id from a search.");
  const m = await call(api, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
  let plain = "";
  let html = "";
  const attachments: { filename: string; mimeType: string; size: number }[] = [];
  walk(m.payload, (p) => {
    if (p.filename) {
      attachments.push({ filename: p.filename, mimeType: p.mimeType ?? "", size: p.body?.size ?? 0 });
      return;
    }
    if (!p.body?.data) return;
    if (p.mimeType === "text/plain" && !plain) plain = fromBase64Url(p.body.data);
    else if (p.mimeType === "text/html" && !html) html = fromBase64Url(p.body.data);
  });
  const body = clip((plain || (html ? htmlToText(html) : "") || decodeEntities(String(m.snippet ?? ""))).trim());
  return {
    id: String(m.id),
    threadId: String(m.threadId ?? ""),
    from: header(m.payload, "From"),
    to: header(m.payload, "To"),
    cc: header(m.payload, "Cc"),
    subject: header(m.payload, "Subject"),
    date: header(m.payload, "Date"),
    unread: Array.isArray(m.labelIds) && m.labelIds.includes("UNREAD"),
    body: body.text,
    truncated: body.truncated,
    attachments,
  };
}

/** The raw RFC 2822 message Gmail sends: plain text, UTF-8. */
export function buildMime(msg: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; headers?: string[] }): string {
  const lines = [
    `To: ${msg.to.join(", ")}`,
    ...(msg.cc?.length ? [`Cc: ${msg.cc.join(", ")}`] : []),
    ...(msg.bcc?.length ? [`Bcc: ${msg.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    ...(msg.headers ?? []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    (utf8ToBase64(msg.body).match(/.{1,76}/g) ?? [""]).join("\r\n"),
  ];
  return lines.join("\r\n");
}

/** Sends an email from the mailbox, or with `replyTo` (an email's id) a reply
 * in its thread, to its sender unless `to` says otherwise. */
export async function gmailSend(api: Api, args: { to?: unknown; cc?: unknown; bcc?: unknown; subject?: string; body?: string; replyTo?: string }) {
  const to = addresses(args.to);
  const cc = addresses(args.cc);
  const bcc = addresses(args.bcc);
  const body = String(args.body ?? "");
  if (!body.trim()) throw new Error("The email has no text.");
  let subject = oneLine(args.subject);
  const extra: string[] = [];
  let threadId: string | undefined;
  const replyTo = oneLine(args.replyTo);
  if (replyTo) {
    const wanted = ["Message-ID", "References", "Subject", "From", "Reply-To"].map((h) => `metadataHeaders=${h}`).join("&");
    const orig = await call(api, `${GMAIL}/messages/${encodeURIComponent(replyTo)}?format=metadata&${wanted}`);
    threadId = orig.threadId;
    const messageId = oneLine(header(orig.payload, "Message-ID"));
    if (messageId) extra.push(`In-Reply-To: ${messageId}`, `References: ${[oneLine(header(orig.payload, "References")), messageId].filter(Boolean).join(" ")}`);
    const original = oneLine(header(orig.payload, "Subject"));
    if (!subject) subject = /^re:/i.test(original) ? original : `Re: ${original}`;
    if (!to.length) to.push(...addresses(header(orig.payload, "Reply-To") || header(orig.payload, "From")));
  }
  if (!to.length) throw new Error("Who is the email to?");
  const raw = toBase64Url(buildMime({ to, cc, bcc, subject, body, headers: extra }));
  const sent = await call(api, `${GMAIL}/messages/send`, { method: "POST", body: JSON.stringify(threadId ? { raw, threadId } : { raw }) });
  return { sent: true, id: String(sent?.id ?? ""), threadId: String(sent?.threadId ?? threadId ?? ""), to, cc, bcc, subject };
}

// ----- Outlook (Microsoft Graph) -------------------------------------------------------

interface GraphAddress {
  emailAddress?: { name?: string; address?: string };
}

function who(a: GraphAddress | undefined): string {
  const { name, address } = a?.emailAddress ?? {};
  return name && address && name !== address ? `${name} <${address}>` : address ?? name ?? "";
}

function recipients(list: string[]) {
  return list.map((item) => {
    const m = item.match(/^(.*)<([^<>]+)>\s*$/);
    return m ? { emailAddress: { name: m[1].trim().replace(/^"|"$/g, ""), address: m[2].trim() } } : { emailAddress: { address: item } };
  });
}

/** The mailbox's address. */
export async function outlookProfile(api: Api) {
  const me = await call(api, `${GRAPH}?$select=mail,userPrincipalName,displayName`);
  return { email: String(me?.mail || me?.userPrincipalName || "") };
}

/** Outlook's well-known folders, by the names people use too. */
const FOLDERS: Record<string, string> = {
  inbox: "inbox",
  deleteditems: "deleteditems",
  deleted: "deleteditems",
  trash: "deleteditems",
  junkemail: "junkemail",
  junk: "junkemail",
  spam: "junkemail",
  sentitems: "sentitems",
  sent: "sentitems",
  drafts: "drafts",
  archive: "archive",
};

/** The messages of one folder, or of the whole mailbox. */
function outlookMessages(folder: unknown): string {
  const f = oneLine(folder).toLowerCase().replace(/[\s_-]+/g, "");
  if (!f) return `${GRAPH}/messages`;
  if (!FOLDERS[f]) throw new Error(`Outlook has no folder “${oneLine(folder)}” here. Use inbox, deleteditems, junkemail, sentitems, drafts or archive.`);
  return `${GRAPH}/mailFolders/${FOLDERS[f]}/messages`;
}

/** Emails matching words (Outlook search), or the newest without them: in the
 * inbox, or in `folder` (deleteditems, junkemail, sentitems…). */
export async function outlookSearch(api: Api, args: { query?: string; max?: number; folder?: string }) {
  const n = clamp(args.max, 1, 25, 10);
  const q = oneLine(args.query).replace(/"/g, "");
  const select = "$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,conversationId";
  const url = q
    ? `${outlookMessages(args.folder)}?$search=${encodeURIComponent(`"${q}"`)}&$top=${n}&${select}`
    : `${outlookMessages(args.folder || "inbox")}?$top=${n}&$orderby=${encodeURIComponent("receivedDateTime desc")}&${select}`;
  const list = await call(api, url);
  return (list?.value ?? []).map((m: any) => ({
    id: String(m.id),
    threadId: String(m.conversationId ?? ""),
    from: who(m.from),
    to: (m.toRecipients ?? []).map(who).join(", "),
    subject: String(m.subject ?? ""),
    date: String(m.receivedDateTime ?? ""),
    snippet: String(m.bodyPreview ?? ""),
    unread: m.isRead === false,
  }));
}

/** One email, its text and its attachments' names. */
export async function outlookRead(api: Api, args: { id: string }) {
  const id = oneLine(args.id);
  if (!id) throw new Error("Which email? Give its id from a search.");
  const select = "$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,isRead,conversationId";
  const m = await call(api, `${GRAPH}/messages/${encodeURIComponent(id)}?${select}`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
  const content = String(m.body?.content ?? "");
  const body = clip((m.body?.contentType === "html" ? htmlToText(content) : content).trim());
  let attachments: { filename: string; mimeType: string; size: number }[] = [];
  if (m.hasAttachments) {
    const list = await call(api, `${GRAPH}/messages/${encodeURIComponent(id)}/attachments?$select=name,contentType,size`);
    attachments = (list?.value ?? []).map((a: any) => ({ filename: String(a.name ?? ""), mimeType: String(a.contentType ?? ""), size: Number(a.size ?? 0) }));
  }
  return {
    id,
    threadId: String(m.conversationId ?? ""),
    from: who(m.from),
    to: (m.toRecipients ?? []).map(who).join(", "),
    cc: (m.ccRecipients ?? []).map(who).join(", "),
    subject: String(m.subject ?? ""),
    date: String(m.receivedDateTime ?? ""),
    unread: m.isRead === false,
    body: body.text,
    truncated: body.truncated,
    attachments,
  };
}

/** Sends an email, or with `replyTo` (an email's id) replies to it in its thread. */
export async function outlookSend(api: Api, args: { to?: unknown; cc?: unknown; bcc?: unknown; subject?: string; body?: string; replyTo?: string }) {
  const to = addresses(args.to);
  const cc = addresses(args.cc);
  const bcc = addresses(args.bcc);
  const body = String(args.body ?? "");
  if (!body.trim()) throw new Error("The email has no text.");
  const replyTo = oneLine(args.replyTo);
  if (replyTo) {
    const message: Record<string, unknown> = {};
    if (to.length) message.toRecipients = recipients(to);
    if (cc.length) message.ccRecipients = recipients(cc);
    if (bcc.length) message.bccRecipients = recipients(bcc);
    await call(api, `${GRAPH}/messages/${encodeURIComponent(replyTo)}/reply`, {
      method: "POST",
      body: JSON.stringify(Object.keys(message).length ? { comment: body, message } : { comment: body }),
    });
    return { sent: true, replyTo, to, cc, bcc, subject: oneLine(args.subject) };
  }
  if (!to.length) throw new Error("Who is the email to?");
  const subject = oneLine(args.subject);
  await call(api, `${GRAPH}/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: recipients(to),
        ...(cc.length ? { ccRecipients: recipients(cc) } : {}),
        ...(bcc.length ? { bccRecipients: recipients(bcc) } : {}),
      },
      saveToSentItems: true,
    }),
  });
  return { sent: true, to, cc, bcc, subject };
}

// ----- deleting and restoring ------------------------------------------------------

/** The most emails one delete reaches (a bot can ask again for more). */
export const MAX_DELETE = 500;
/** How many emails a preview names before “and N more”. */
const NAMED = 8;

/** What a delete reaches: the emails with these ids, or up to `max` (newest
 * first) matching a search, or in an Outlook folder. */
export interface Target {
  ids?: unknown;
  query?: string;
  folder?: string;
  max?: number;
}

/** What a delete would reach, before it happens: every id, and the first few by name. */
export interface Preview {
  total: number;
  ids: string[];
  named: { id: string; from: string; subject: string; date: string }[];
}

/** Ids from a list or a comma/space separated string: each once, each one line. */
function idList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : String(value).split(/[,\s]+/);
  return [...new Set(list.map((id) => oneLine(id)).filter(Boolean))];
}

/** `fn` for every item, at most `limit` at a time (Outlook allows 4 calls at once per mailbox). */
async function eachLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** What went through and what didn't. When nothing did, the first error is
 * thrown as it came (so an expired token is renewed and the whole thing retried). */
function tally<R>(ids: string[], results: PromiseSettledResult<R>[]) {
  const failed: { id: string; error: string }[] = [];
  const done: { id: string; value: R }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") done.push({ id: ids[i], value: r.value });
    else failed.push({ id: ids[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  if (!done.length && failed.length) throw (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
  return { done, failed };
}

function whoShort(from: string): string {
  return from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)?.[1] ?? from;
}

async function gmailTargets(api: Api, args: Target): Promise<string[]> {
  const given = idList(args.ids);
  if (given.length) return given.slice(0, MAX_DELETE);
  const q = oneLine(args.query);
  if (!q) throw new Error("Which emails? Give their ids from a search, or a search to delete what matches.");
  const max = clamp(args.max, 1, MAX_DELETE, 50);
  // Gmail leaves Trash and Spam out of searches unless asked for them by name.
  const everywhere = /\bin:(trash|spam|anywhere)\b/i.test(q);
  const ids: string[] = [];
  let page = "";
  do {
    const list = await call(api, `${GMAIL}/messages?maxResults=${Math.min(500, max - ids.length)}&q=${encodeURIComponent(q)}${everywhere ? "&includeSpamTrash=true" : ""}${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
    for (const m of list?.messages ?? []) if (ids.length < max) ids.push(String(m.id));
    page = list?.nextPageToken ?? "";
  } while (page && ids.length < max);
  return ids;
}

/** Which emails a Gmail delete would reach, the first few by sender, subject and date. */
export async function gmailPeek(api: Api, args: Target): Promise<Preview> {
  const ids = await gmailTargets(api, args);
  const wanted = ["From", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
  const named = await Promise.all(ids.slice(0, NAMED).map(async (id) => {
    const m = await call(api, `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&${wanted}`);
    return { id, from: whoShort(header(m.payload, "From")), subject: header(m.payload, "Subject"), date: header(m.payload, "Date") };
  }));
  return { total: ids.length, ids, named };
}

/** Deletes emails from Gmail: to Trash, where Gmail keeps them 30 days
 * (gmailRestore brings them back), or with `forever`, for good. */
export async function gmailDelete(api: Api, args: Target & { forever?: boolean }) {
  const ids = await gmailTargets(api, args);
  if (!ids.length) return { deleted: 0, forever: !!args.forever, ids: [] as string[], failed: [] as { id: string; error: string }[] };
  if (args.forever) {
    for (let i = 0; i < ids.length; i += 1000) {
      await call(api, `${GMAIL}/messages/batchDelete`, { method: "POST", body: JSON.stringify({ ids: ids.slice(i, i + 1000) }) });
    }
    return { deleted: ids.length, forever: true, ids, failed: [] as { id: string; error: string }[] };
  }
  const { done, failed } = tally(ids, await eachLimit(ids, 10, (id) => call(api, `${GMAIL}/messages/${encodeURIComponent(id)}/trash`, { method: "POST" })));
  return { deleted: done.length, forever: false, ids: done.map((d) => d.id), failed };
}

/** Brings emails back out of Gmail's Trash. */
export async function gmailRestore(api: Api, args: { ids?: unknown }) {
  const ids = idList(args.ids).slice(0, MAX_DELETE);
  if (!ids.length) throw new Error("Which emails? Give the ids the delete gave back.");
  const { done, failed } = tally(ids, await eachLimit(ids, 10, (id) => call(api, `${GMAIL}/messages/${encodeURIComponent(id)}/untrash`, { method: "POST" })));
  return { restored: done.length, ids: done.map((d) => d.id), failed };
}

async function outlookTargets(api: Api, args: Target): Promise<{ id: string; from: string; subject: string; date: string }[]> {
  const given = idList(args.ids);
  if (given.length) return given.slice(0, MAX_DELETE).map((id) => ({ id, from: "", subject: "", date: "" }));
  const q = oneLine(args.query).replace(/"/g, "");
  if (!q && !oneLine(args.folder)) throw new Error("Which emails? Give their ids from a search, a search, or a folder.");
  const max = clamp(args.max, 1, MAX_DELETE, 50);
  const select = "$select=id,subject,from,receivedDateTime";
  const top = Math.min(max, 250);
  let url: string | null = q
    ? `${outlookMessages(args.folder)}?$search=${encodeURIComponent(`"${q}"`)}&$top=${top}&${select}`
    : `${outlookMessages(args.folder)}?$top=${top}&$orderby=${encodeURIComponent("receivedDateTime desc")}&${select}`;
  const found: { id: string; from: string; subject: string; date: string }[] = [];
  while (url && found.length < max) {
    const page: any = await call(api, url);
    for (const m of page?.value ?? []) {
      if (found.length < max) found.push({ id: String(m.id), from: whoShort(who(m.from)), subject: String(m.subject ?? ""), date: String(m.receivedDateTime ?? "") });
    }
    url = typeof page?.["@odata.nextLink"] === "string" && page["@odata.nextLink"].startsWith(`${GRAPH}/`) ? page["@odata.nextLink"] : null;
  }
  return found;
}

/** Which emails an Outlook delete would reach, the first few by sender, subject and date. */
export async function outlookPeek(api: Api, args: Target): Promise<Preview> {
  const found = await outlookTargets(api, args);
  const results = await eachLimit(found.slice(0, NAMED), 4, async (m) => {
    if (m.subject || m.from) return m;
    const full = await call(api, `${GRAPH}/messages/${encodeURIComponent(m.id)}?$select=subject,from,receivedDateTime`);
    return { id: m.id, from: whoShort(who(full.from)), subject: String(full.subject ?? ""), date: String(full.receivedDateTime ?? "") };
  });
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (rejected) throw rejected.reason;
  const named = results.map((r) => (r as PromiseFulfilledResult<(typeof found)[number]>).value);
  return { total: found.length, ids: found.map((m) => m.id), named };
}

/** Deletes emails from Outlook: to Deleted Items (outlookRestore brings them
 * back, by the new ids they get there), or with `forever`, for good. */
export async function outlookDelete(api: Api, args: Target & { forever?: boolean }) {
  const ids = (await outlookTargets(api, args)).map((m) => m.id);
  if (!ids.length) return { deleted: 0, forever: !!args.forever, ids: [] as string[], failed: [] as { id: string; error: string }[] };
  if (args.forever) {
    const { done, failed } = tally(ids, await eachLimit(ids, 4, (id) => call(api, `${GRAPH}/messages/${encodeURIComponent(id)}/permanentDelete`, { method: "POST" })));
    return { deleted: done.length, forever: true, ids: done.map((d) => d.id), failed };
  }
  const move = (id: string) => call(api, `${GRAPH}/messages/${encodeURIComponent(id)}/move`, { method: "POST", body: JSON.stringify({ destinationId: "deleteditems" }) });
  const { done, failed } = tally(ids, await eachLimit(ids, 4, move));
  return { deleted: done.length, forever: false, ids: done.map((d) => String(d.value?.id ?? d.id)), failed };
}

/** Moves emails back to the inbox (from Deleted Items, or anywhere else). */
export async function outlookRestore(api: Api, args: { ids?: unknown }) {
  const ids = idList(args.ids).slice(0, MAX_DELETE);
  if (!ids.length) throw new Error("Which emails? Give the ids the delete gave back.");
  const move = (id: string) => call(api, `${GRAPH}/messages/${encodeURIComponent(id)}/move`, { method: "POST", body: JSON.stringify({ destinationId: "inbox" }) });
  const { done, failed } = tally(ids, await eachLimit(ids, 4, move));
  return { restored: done.length, ids: done.map((d) => String(d.value?.id ?? d.id)), failed };
}
