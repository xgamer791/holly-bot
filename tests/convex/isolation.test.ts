/// <reference types="vite/client" />
// Two accounts side by side: each account's plugins (connected Gmail, Outlook
// and GitHub, and the MCP servers, search keys and skills in its settings)
// are its own. The other account can't see, use, change or delete them, even
// when it names the same service, store or key. npm run test:convex.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.*s");
const SITE = "https://xgamer791.github.io/holly-bot/";
const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 29 + 3) % 256)));
const TOKEN_A = `ghp_${"Aa1".repeat(12)}`;
const TOKEN_B = `ghp_${"Bb2".repeat(12)}`;

let t: ReturnType<typeof convexTest>;
/** Every call Google and GitHub received, with the token it carried. */
let seen: { host: string; path: string; token: string }[];

beforeEach(() => {
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
  vi.stubEnv("SITE_URL", "https://xgamer791.github.io/holly-bot");
  vi.stubEnv("CONNECTORS_KEY", KEY);
  vi.stubEnv("CONNECT_GOOGLE_ID", "google-id");
  vi.stubEnv("CONNECT_GOOGLE_SECRET", "google-secret");
  seen = [];
  // Google and GitHub: who a token belongs to decides what comes back.
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    seen.push({ host: url.host, path: url.pathname, token });
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
      return json({ access_token: "gmail-token-of-a", refresh_token: "gmail-refresh-of-a", expires_in: 3600, scope: "https://mail.google.com/" });
    }
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") return json({});
    if (url.host === "gmail.googleapis.com") {
      if (token !== "gmail-token-of-a") return json({ error: { message: "Invalid Credentials" } }, 401);
      if (url.pathname.endsWith("/profile")) return json({ emailAddress: "alice@gmail.com" });
      return json({ messages: [] });
    }
    if (url.host === "api.github.com") {
      const login = token === TOKEN_A ? "alice-gh" : token === TOKEN_B ? "bob-gh" : null;
      if (!login) return json({ message: "Bad credentials" }, 401);
      if (url.pathname === "/user") return json({ login }, 200, { "x-oauth-scopes": "repo, delete_repo" });
      if (url.pathname === "/user/repos") return json([{ full_name: `${login}/private-notes`, private: true, default_branch: "main", html_url: "" }]);
    }
    return json({ message: "Not Found" }, 404);
  });
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A signed-in account (a user with an active subscription, and a live
 * session), called as that session. */
async function account(email: string) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 });
    // Holly Bot's server keeps an account's data only while it has an active
    // subscription (convex/lib/subscription.ts).
    await ctx.db.insert("subscribers", {
      userId,
      livemode: false,
      stripeCustomerId: `cus_${userId}`,
      stripeSubscriptionId: `sub_${userId}`,
      plan: "starter",
      billingInterval: "month",
      subscriptionStatus: "active",
      currentPeriodEnd: Date.now() + 30 * 86_400_000,
      serverStatus: "ready",
      updatedAt: Date.now(),
    });
    return { userId, sessionId };
  });
  return { userId, sessionId, as: t.withIdentity({ subject: `${userId}|${sessionId}` }) };
}

/** Connects Gmail the whole way: consent screen, callback, claim. */
async function connectGmail(a: Awaited<ReturnType<typeof account>>) {
  const authorize = new URL(await a.as.action(api.connectors.start, { service: "gmail", returnTo: SITE }));
  const res = await t.fetch(`/connectors/gmail/callback?state=${authorize.searchParams.get("state")}&code=code-a`, { method: "GET" });
  const claim = new URL(res.headers.get("location")!).searchParams.get("connect")!;
  return a.as.mutation(api.connectors.claim, { claim });
}

describe("connected accounts stay with the Holly Bot account that connected them", () => {
  test("each account sees, uses and removes only its own", async () => {
    const alice = await account("alice@example.com");
    const bob = await account("bob@example.com");
    expect(await connectGmail(alice)).toEqual({ service: "gmail", account: "alice@gmail.com" });
    expect(await alice.as.action(api.connectors.connectToken, { token: TOKEN_A })).toEqual({ service: "github", account: "alice-gh" });
    expect(await bob.as.action(api.connectors.connectToken, { token: TOKEN_B })).toEqual({ service: "github", account: "bob-gh" });

    // Seeing: each list is its own.
    const mine = async (a: typeof alice) => (await a.as.query(api.connectors.list, {})).map((c) => `${c.service}:${c.account}`).sort();
    expect(await mine(alice)).toEqual(["github:alice-gh", "gmail:alice@gmail.com"]);
    expect(await mine(bob)).toEqual(["github:bob-gh"]);

    // Using: the same request goes out with the caller's own token, never the other's.
    seen = [];
    expect(await bob.as.action(api.connectors.run, { service: "github", op: "list_repos", args: {} })).toMatchObject([{ repo: "bob-gh/private-notes" }]);
    expect(seen.map((s) => s.token)).toEqual([TOKEN_B]);
    seen = [];
    expect(await alice.as.action(api.connectors.run, { service: "github", op: "list_repos", args: {} })).toMatchObject([{ repo: "alice-gh/private-notes" }]);
    expect(seen.map((s) => s.token)).toEqual([TOKEN_A]);
    // Bob has no Gmail, and Alice's is out of his reach: nothing even goes to Google.
    seen = [];
    for (const op of ["search", "read", "send"]) {
      await expect(bob.as.action(api.connectors.run, { service: "gmail", op, args: { id: "x", to: "bob@example.com", body: "hi" } })).rejects.toThrow(/Gmail isn't connected/);
    }
    expect(seen).toEqual([]);

    // Removing: Bob disconnecting Gmail or GitHub touches only his own.
    await bob.as.action(api.connectors.disconnect, { service: "gmail" });
    await bob.as.action(api.connectors.disconnect, { service: "github" });
    expect(seen.filter((s) => s.path === "/revoke")).toEqual([]);
    expect(await mine(bob)).toEqual([]);
    expect(await mine(alice)).toEqual(["github:alice-gh", "gmail:alice@gmail.com"]);
    expect(await alice.as.action(api.connectors.run, { service: "gmail", op: "search", args: {} })).toEqual([]);

    // Deleting Bob's whole account leaves Alice's connections alone.
    let done = false;
    while (!done) ({ done } = await bob.as.mutation(api.account.deleteAccount, {}));
    expect(await mine(alice)).toEqual(["github:alice-gh", "gmail:alice@gmail.com"]);
    const rows = await t.run((ctx) => ctx.db.query("connections").collect());
    expect(rows.every((row) => row.userId === alice.userId)).toBe(true);
  });

  test("the same account's other sessions (another phone, a linked Holly Computer) share them; nobody else does", async () => {
    const alice = await account("alice@example.com");
    const bob = await account("bob@example.com");
    await alice.as.action(api.connectors.connectToken, { token: TOKEN_A });
    // Alice's Holly Computer signs in with a session of its own on her account.
    const computerSession = await t.run((ctx) => ctx.db.insert("authSessions", { userId: alice.userId, expirationTime: Date.now() + 3_600_000 }));
    const computer = t.withIdentity({ subject: `${alice.userId}|${computerSession}` });
    expect((await computer.query(api.connectors.list, {})).map((c) => c.account)).toEqual(["alice-gh"]);
    seen = [];
    await computer.action(api.connectors.run, { service: "github", op: "list_repos", args: {} });
    expect(seen.map((s) => s.token)).toEqual([TOKEN_A]);
    // An identity naming Bob's account with Alice's session is refused. (Sign-in
    // tokens are signed by the server, so it can't be made; the check doesn't count on it.)
    const mixed = t.withIdentity({ subject: `${bob.userId}|${alice.sessionId}` });
    await expect(mixed.query(api.connectors.list, {})).rejects.toThrow(/Not signed in/);
    await expect(mixed.query(api.data.get, { store: "kv", key: "settings" })).rejects.toThrow(/Not signed in/);
    // Once Alice's computer is unlinked (its session ends), it can't use them.
    await t.run((ctx) => ctx.db.delete(computerSession));
    await expect(computer.query(api.connectors.list, {})).rejects.toThrow(/Not signed in/);
    await expect(computer.action(api.connectors.run, { service: "github", op: "list_repos", args: {} })).rejects.toThrow(/Not signed in/);
  });

  test("a connection in progress can only finish for the account that started it", async () => {
    const alice = await account("alice@example.com");
    const bob = await account("bob@example.com");
    // Bob gets Alice to approve his consent link: the tokens are bound to Bob's
    // start, but the claim lands in Alice's browser, and her account can't take it.
    const authorize = new URL(await bob.as.action(api.connectors.start, { service: "gmail", returnTo: SITE }));
    const res = await t.fetch(`/connectors/gmail/callback?state=${authorize.searchParams.get("state")}&code=alices-approval`, { method: "GET" });
    const claim = new URL(res.headers.get("location")!).searchParams.get("connect")!;
    expect(await alice.as.mutation(api.connectors.claim, { claim })).toMatchObject({ error: expect.stringMatching(/another Holly Bot account/) });
    // Thrown away: Bob can't pick it up afterwards either.
    expect(await bob.as.mutation(api.connectors.claim, { claim })).toMatchObject({ error: expect.stringMatching(/expired/) });
    expect(await alice.as.query(api.connectors.list, {})).toEqual([]);
    expect(await bob.as.query(api.connectors.list, {})).toEqual([]);
  });
});

describe("plugin settings (MCP servers, search keys, skills) stay with their account", () => {
  const settingsOf = (who: string) => ({
    mcpServers: [{ id: `mcp_${who}`, name: `${who}'s Linear`, url: `https://mcp.example.com/${who}`, headers: { Authorization: `Bearer ${who}-mcp-secret` }, enabled: true }],
    services: { tavily: { apiKey: `tvly-${who}-secret` }, exa: { apiKey: `exa-${who}-secret` } },
    skills: [{ id: `skill_${who}`, name: `${who}'s weekly report`, instructions: "…", enabled: true }],
  });
  const put = (value: unknown) => ({ op: "put" as const, store: "kv", key: "settings", data: JSON.stringify({ key: "settings", value }) });

  test("the same store and key are two different records, one per account", async () => {
    const alice = await account("alice@example.com");
    const bob = await account("bob@example.com");
    await alice.as.mutation(api.data.apply, { ops: [put(settingsOf("alice"))] });

    // Bob asking for "kv/settings" gets nothing of Alice's, by key or by listing.
    expect(await bob.as.query(api.data.get, { store: "kv", key: "settings" })).toBeNull();
    const listed = await bob.as.query(api.data.list, { store: "kv", paginationOpts: { numItems: 100, cursor: null } });
    expect(listed.page).toEqual([]);

    // Bob saving his own settings under the same key doesn't touch Alice's.
    await bob.as.mutation(api.data.apply, { ops: [put(settingsOf("bob"))] });
    const aliceSees = JSON.parse((await alice.as.query(api.data.get, { store: "kv", key: "settings" }))!.data).value;
    const bobSees = JSON.parse((await bob.as.query(api.data.get, { store: "kv", key: "settings" }))!.data).value;
    expect(aliceSees).toEqual(settingsOf("alice"));
    expect(bobSees).toEqual(settingsOf("bob"));
    expect(JSON.stringify(bobSees)).not.toContain("alice");

    // Bob deleting, clearing or erasing his account leaves Alice's settings where they are.
    await bob.as.mutation(api.data.apply, { ops: [{ op: "delete", store: "kv", key: "settings" }] });
    await bob.as.mutation(api.data.clearStore, { store: "kv" });
    let done = false;
    while (!done) ({ done } = await bob.as.mutation(api.account.deleteAccount, {}));
    expect(JSON.parse((await alice.as.query(api.data.get, { store: "kv", key: "settings" }))!.data).value).toEqual(settingsOf("alice"));
    const rows = await t.run((ctx) => ctx.db.query("records").collect());
    expect(rows.every((row) => row.userId === alice.userId)).toBe(true);
  });

  test("signed out, nothing is readable or writable", async () => {
    const alice = await account("alice@example.com");
    await alice.as.mutation(api.data.apply, { ops: [put(settingsOf("alice"))] });
    await expect(t.query(api.data.get, { store: "kv", key: "settings" })).rejects.toThrow(/Not signed in/);
    await expect(t.query(api.data.list, { store: "kv", paginationOpts: { numItems: 10, cursor: null } })).rejects.toThrow(/Not signed in/);
    await expect(t.mutation(api.data.apply, { ops: [put({})] })).rejects.toThrow(/Not signed in/);
    // A session that has ended (signed out) is refused too.
    await t.run((ctx) => ctx.db.delete(alice.sessionId));
    await expect(alice.as.query(api.data.get, { store: "kv", key: "settings" })).rejects.toThrow(/Not signed in/);
  });
});
