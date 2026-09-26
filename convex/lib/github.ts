// GitHub for bots, as the account that connected it (convex/connectors.ts):
// its repositories, their files, and any other REST call. Plain functions over
// fetch, so the same code runs in Convex actions and in tests
// (tests/unit/connectors.test.mjs). No imports: the tests load this file
// straight into Node.

type Fetch = typeof fetch;

/** How a call reaches GitHub: the token (none for public reads) and a stand-in fetch for tests. */
export interface GitHubApi {
  token?: string;
  fetch?: Fetch;
}

/** GitHub answered with an error; `status` is its HTTP status. */
export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const GITHUB = "https://api.github.com";

/** Most of a file's text a bot gets back. */
const MAX_FILE = 60_000;
/** Most of a raw API answer a bot gets back. */
const MAX_ANSWER = 30_000;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** "owner/name", checked. */
export function repoName(value: unknown): string {
  const repo = String(value ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`“${value}” isn't a repository. Use owner/name.`);
  return repo;
}

/** A path inside a repository, each part escaped. */
function filePath(value: unknown): string {
  const path = String(value ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (path.split("/").some((part) => part === "..")) throw new Error("A path can't go up a folder.");
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function gh(api: GitHubApi, method: string, path: string, body?: unknown): Promise<{ status: number; data: any; headers: Headers }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Holli-Bot",
  };
  if (api.token) headers.Authorization = `Bearer ${api.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await (api.fetch ?? fetch)(`${GITHUB}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = Array.isArray(data?.errors) ? data.errors.map((e: any) => e?.message ?? e?.code).filter(Boolean).join("; ") : "";
    const message = [data?.message ?? (typeof data === "string" ? data.slice(0, 200) : ""), detail].filter(Boolean).join(": ");
    throw new GitHubError(message || `HTTP ${res.status}`, res.status);
  }
  return { status: res.status, data, headers: res.headers };
}

/** The signed-in user, and the scopes a classic token carries (none listed for fine-grained ones). */
export async function githubUser(api: GitHubApi) {
  const { data, headers } = await gh(api, "GET", "/user");
  const scopes = (headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { login: String(data?.login ?? ""), name: String(data?.name ?? ""), scopes };
}

function repoSummary(r: any) {
  return {
    repo: String(r.full_name),
    private: !!r.private,
    description: String(r.description ?? ""),
    defaultBranch: String(r.default_branch ?? ""),
    url: String(r.html_url ?? ""),
    updated: String(r.pushed_at ?? r.updated_at ?? ""),
    archived: !!r.archived,
  };
}

/** Repositories: the user's own and those they work on, most recently changed first; or `owner`'s public ones. */
export async function listRepos(api: GitHubApi, args: { owner?: string; max?: number }) {
  const n = Math.min(100, Math.max(1, Math.floor(Number(args.max) || 30)));
  const owner = String(args.owner ?? "").trim();
  const path = owner
    ? `/users/${encodeURIComponent(owner)}/repos?per_page=${n}&sort=updated`
    : `/user/repos?per_page=${n}&sort=updated&affiliation=owner,collaborator,organization_member`;
  const { data } = await gh(api, "GET", path);
  return (Array.isArray(data) ? data : []).map(repoSummary);
}

/** A new repository, private unless `private` is false, under the user or an organization. */
export async function createRepo(api: GitHubApi, args: { name?: string; description?: string; private?: boolean; org?: string; autoInit?: boolean }) {
  const name = String(args.name ?? "").trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error("A repository name uses letters, numbers, - _ and . only.");
  const org = String(args.org ?? "").trim();
  const { data } = await gh(api, "POST", org ? `/orgs/${encodeURIComponent(org)}/repos` : "/user/repos", {
    name,
    description: String(args.description ?? ""),
    private: args.private !== false,
    auto_init: args.autoInit !== false,
  });
  return repoSummary(data);
}

/** Renames, re-describes, or changes the visibility, default branch or archive state of a repository. */
export async function updateRepo(api: GitHubApi, args: { repo?: string; name?: string; description?: string; private?: boolean; archived?: boolean; defaultBranch?: string; homepage?: string }) {
  const repo = repoName(args.repo);
  const patch: Record<string, unknown> = {};
  if (args.name !== undefined) patch.name = String(args.name).trim();
  if (args.description !== undefined) patch.description = String(args.description);
  if (args.private !== undefined) patch.private = !!args.private;
  if (args.archived !== undefined) patch.archived = !!args.archived;
  if (args.defaultBranch !== undefined) patch.default_branch = String(args.defaultBranch).trim();
  if (args.homepage !== undefined) patch.homepage = String(args.homepage);
  if (!Object.keys(patch).length) throw new Error("Nothing to change.");
  const { data } = await gh(api, "PATCH", `/repos/${repo}`, patch);
  return repoSummary(data);
}

/** Deletes a repository, for good. */
export async function deleteRepo(api: GitHubApi, args: { repo?: string }) {
  const repo = repoName(args.repo);
  await gh(api, "DELETE", `/repos/${repo}`);
  return { deleted: true, repo };
}

/** What's in a folder of a repository (the top by default). */
export async function listFiles(api: GitHubApi, args: { repo?: string; path?: string; ref?: string }) {
  const repo = repoName(args.repo);
  const ref = String(args.ref ?? "").trim();
  const path = filePath(args.path);
  const { data } = await gh(api, "GET", `/repos/${repo}/contents${path ? `/${path}` : ""}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
  if (!Array.isArray(data)) return [{ path: String(data?.path ?? ""), type: String(data?.type ?? "file"), size: Number(data?.size ?? 0) }];
  return data.map((f: any) => ({ path: String(f.path), type: String(f.type), size: Number(f.size ?? 0) }));
}

/** A file's text (or, for a binary file, its size). */
export async function readFile(api: GitHubApi, args: { repo?: string; path?: string; ref?: string }) {
  const repo = repoName(args.repo);
  const path = filePath(args.path);
  if (!path) throw new Error("Which file?");
  const ref = String(args.ref ?? "").trim();
  const { data } = await gh(api, "GET", `/repos/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
  if (Array.isArray(data)) throw new Error(`${args.path} is a folder. List it instead.`);
  if (data?.type !== "file") throw new Error(`${args.path} is a ${data?.type ?? "thing"}, not a file.`);
  const base = { repo, path: String(data.path), sha: String(data.sha), size: Number(data.size ?? 0), url: String(data.html_url ?? "") };
  if (data.encoding !== "base64" || typeof data.content !== "string") return { ...base, binary: true, text: "", note: "Too large to read through the API; open it on GitHub." };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(data.content));
  } catch {
    return { ...base, binary: true, text: "" };
  }
  const cut = text.length > MAX_FILE;
  return { ...base, binary: false, text: cut ? `${text.slice(0, MAX_FILE)}\n\n[…cut: ${text.length - MAX_FILE} more characters]` : text, truncated: cut };
}

async function currentSha(api: GitHubApi, repo: string, path: string, branch: string) {
  try {
    const { data } = await gh(api, "GET", `/repos/${repo}/contents/${path}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`);
    return Array.isArray(data) ? null : String(data?.sha ?? "") || null;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

/** Creates or replaces a file with `content`, as one commit (on `branch`, or the default branch). */
export async function writeFile(api: GitHubApi, args: { repo?: string; path?: string; content?: string; message?: string; branch?: string }) {
  const repo = repoName(args.repo);
  const path = filePath(args.path);
  if (!path) throw new Error("Which file?");
  const branch = String(args.branch ?? "").trim();
  const sha = await currentSha(api, repo, path, branch);
  const content = String(args.content ?? "");
  const { data } = await gh(api, "PUT", `/repos/${repo}/contents/${path}`, {
    message: String(args.message ?? "").trim() || `${sha ? "Update" : "Add"} ${decodeURIComponent(path)}`,
    content: bytesToBase64(new TextEncoder().encode(content)),
    ...(sha ? { sha } : {}),
    ...(branch ? { branch } : {}),
  });
  return { repo, path: decodeURIComponent(path), created: !sha, commit: String(data?.commit?.sha ?? ""), url: String(data?.content?.html_url ?? "") };
}

/** Deletes a file, as one commit. */
export async function deleteFile(api: GitHubApi, args: { repo?: string; path?: string; message?: string; branch?: string }) {
  const repo = repoName(args.repo);
  const path = filePath(args.path);
  if (!path) throw new Error("Which file?");
  const branch = String(args.branch ?? "").trim();
  const sha = await currentSha(api, repo, path, branch);
  if (!sha) throw new Error(`${args.path} isn't in ${repo}.`);
  const { data } = await gh(api, "DELETE", `/repos/${repo}/contents/${path}`, {
    message: String(args.message ?? "").trim() || `Delete ${decodeURIComponent(path)}`,
    sha,
    ...(branch ? { branch } : {}),
  });
  return { repo, path: decodeURIComponent(path), deleted: true, commit: String(data?.commit?.sha ?? "") };
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Any GitHub REST call (issues, pull requests, branches, releases…): its status and answer as JSON text. */
export async function request(api: GitHubApi, args: { method?: string; path?: string; body?: unknown }) {
  const method = String(args.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) throw new Error(`${method} isn't a GitHub API method.`);
  const path = String(args.path ?? "").trim().replace(/^https:\/\/api\.github\.com/, "");
  if (!path.startsWith("/") || path.includes("..") || /[\s#]/.test(path)) throw new Error("Give an API path like /repos/owner/name/issues.");
  // Deleting a repository goes through deleteRepo, which the app always asks about first.
  if (method === "DELETE" && /^\/repos\/[^/]+\/[^/?]+\/?(\?.*)?$/.test(path)) throw new Error("Delete a repository with delete_repo instead.");
  let body = args.body;
  if (typeof body === "string" && body.trim()) {
    try {
      body = JSON.parse(body);
    } catch {
      throw new Error("The body must be JSON.");
    }
  }
  // GET never carries a body; a DELETE only when one is given (deleting a file needs one).
  const payload = method === "GET" ? undefined : body === undefined || body === "" ? (method === "DELETE" ? undefined : {}) : body;
  const { status, data } = await gh(api, method, path, payload);
  const text = data === null ? "" : typeof data === "string" ? data : JSON.stringify(data, null, 1);
  return { status, body: text.length > MAX_ANSWER ? `${text.slice(0, MAX_ANSWER)}\n…[cut: ${text.length - MAX_ANSWER} more characters]` : text };
}
