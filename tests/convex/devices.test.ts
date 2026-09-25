/// <reference types="vite/client" />
// Holly Computer on the account (convex/devices.ts): a running computer says
// where it can be reached, or why it can't be; the first device to connect to
// it (Connect, on the phone) pairs it, and then the account's devices connect
// to it by themselves. npm run test:convex.
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";

const modules = import.meta.glob("../../convex/**/*.*s");
const ACCESS = "a".repeat(43);
const URL_A = "https://plant-him-dictionary-willow.trycloudflare.com";

let t: ReturnType<typeof convexTest>;

beforeEach(() => {
  t = convexTest(schema, modules);
});

/** An account signed in on a phone, with a computer linked to it (its own session). */
async function accountWithComputer(email: string) {
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    const phoneSession = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 });
    const computerSession = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 });
    const deviceId = await ctx.db.insert("devices", { userId, sessionId: computerSession, name: "GOAT", linkedAt: Date.now() });
    return { userId, phoneSession, computerSession, deviceId };
  });
  return {
    ...ids,
    phone: t.withIdentity({ subject: `${ids.userId}|${ids.phoneSession}` }),
    computer: t.withIdentity({ subject: `${ids.userId}|${ids.computerSession}` }),
  };
}

describe("where a linked computer can be reached", () => {
  test("its address while its tunnel works; otherwise why not", async () => {
    const a = await accountWithComputer("alice@example.com");
    const listed = async () => (await a.phone.query(api.devices.list, {}))[0];

    await a.computer.mutation(api.devices.report, { url: "", access: "", tunnel: "starting" });
    expect(await listed()).toMatchObject({ name: "GOAT", tunnel: "starting", paired: false, server: false });
    expect((await listed()).url).toBeUndefined();

    await a.computer.mutation(api.devices.report, { url: "", access: "", tunnel: "blocked" });
    expect((await listed()).tunnel).toBe("blocked");

    // An address that works: no reason any more.
    await a.computer.mutation(api.devices.report, { url: URL_A, access: ACCESS, tunnel: "blocked" });
    expect(await listed()).toMatchObject({ url: URL_A, access: ACCESS });
    expect((await listed()).tunnel).toBeUndefined();

    // Only the reasons the app knows are kept.
    await a.computer.mutation(api.devices.report, { url: "", access: "", tunnel: "<b>hi</b>" });
    expect((await listed()).tunnel).toBeUndefined();

    // Stopping clears it all.
    await a.computer.mutation(api.devices.report, { url: "", access: "", tunnel: "starting" });
    await a.computer.mutation(api.devices.report, { url: "", access: "", stopping: true });
    const stopped = await listed();
    expect(stopped.tunnel).toBeUndefined();
    expect(stopped.stoppedAt).toBeTypeOf("number");
  });

  test("an older Holly Computer, which doesn't say why, still reports", async () => {
    const a = await accountWithComputer("alice@example.com");
    await a.computer.mutation(api.devices.report, { url: "", access: "" });
    expect(await a.phone.query(api.devices.list, {})).toMatchObject([{ name: "GOAT", paired: false }]);
  });
});

describe("which computer it is, for its bots to tell", () => {
  test("a report says which of the account's computers it is, and keeps its system", async () => {
    const a = await accountWithComputer("alice@example.com");
    const listed = async () => (await a.phone.query(api.devices.list, {}))[0];

    expect(await a.computer.mutation(api.devices.report, { url: "", access: "", tunnel: "starting", platform: "win32" }))
      .toEqual({ server: false, id: a.deviceId });
    expect(await listed()).toMatchObject({ id: a.deviceId, name: "GOAT", platform: "win32" });

    // Only the systems Node names are kept, and a report that doesn't say keeps what it said.
    await a.computer.mutation(api.devices.report, { url: "", access: "", platform: "<b>hi</b>" });
    expect((await listed()).platform).toBe("win32");
    await a.computer.mutation(api.devices.report, { url: URL_A, access: ACCESS });
    expect((await listed()).platform).toBe("win32");
    await a.computer.mutation(api.devices.report, { url: URL_A, access: ACCESS, platform: "darwin" });
    expect((await listed()).platform).toBe("darwin");

    // Stopping says which it is too, and its system stays.
    expect(await a.computer.mutation(api.devices.report, { url: "", access: "", stopping: true }))
      .toEqual({ server: false, id: a.deviceId });
    expect((await listed()).platform).toBe("darwin");
  });

  test("the plan's server hears it's the server", async () => {
    const a = await accountWithComputer("alice@example.com");
    await t.run(async (ctx) => ctx.db.patch(a.deviceId, { serverKey: "srv_1" }));
    expect(await a.computer.mutation(api.devices.report, { url: "", access: "", platform: "linux" }))
      .toEqual({ server: true, id: a.deviceId });
    expect(await a.phone.query(api.devices.list, {})).toMatchObject([{ server: true, platform: "linux" }]);
  });

  test("another account's computer can't report as this one", async () => {
    const alice = await accountWithComputer("alice@example.com");
    const bob = await accountWithComputer("bob@example.com");
    // Bob's phone isn't a linked computer, so it can't say where it is.
    await expect(bob.phone.mutation(api.devices.report, { url: "", access: "", platform: "win32" }))
      .rejects.toThrow(/Only a linked Holly Computer/);
    expect((await alice.phone.query(api.devices.list, {}))[0].platform).toBeUndefined();
  });
});

describe("pairing: Connect on the phone, the first time", () => {
  test("a device that connected pairs the computer, for all the account's devices", async () => {
    const a = await accountWithComputer("alice@example.com");
    expect((await a.phone.query(api.devices.list, {}))[0].paired).toBe(false);
    await a.phone.mutation(api.devices.pair, { id: a.deviceId });
    expect((await a.phone.query(api.devices.list, {}))[0].paired).toBe(true);
    // Once is enough: pairing again keeps the first time.
    const first = await t.run(async (ctx) => (await ctx.db.get(a.deviceId))?.pairedAt);
    await a.phone.mutation(api.devices.pair, { id: a.deviceId });
    expect(await t.run(async (ctx) => (await ctx.db.get(a.deviceId))?.pairedAt)).toBe(first);
  });

  test("nobody can pair another account's computer", async () => {
    const alice = await accountWithComputer("alice@example.com");
    const bob = await accountWithComputer("bob@example.com");
    await bob.phone.mutation(api.devices.pair, { id: alice.deviceId });
    expect((await alice.phone.query(api.devices.list, {}))[0].paired).toBe(false);
    await expect(t.mutation(api.devices.pair, { id: alice.deviceId })).rejects.toThrow(/Not signed in/);
  });

  test("a computer renewing its link stays paired", async () => {
    const a = await accountWithComputer("alice@example.com");
    await a.phone.mutation(api.devices.pair, { id: a.deviceId });
    // Holly Computer renews its own link after 300 days: a new code from its
    // own session, redeemed for a new session (convex/auth.ts device).
    const codeHash = "b".repeat(64);
    await a.computer.mutation(api.devices.createLink, { codeHash });
    const renewed = await t.mutation(internal.devices.redeem, { codeHash, name: "GOAT" });
    expect(renewed).not.toBeNull();
    const rows = await t.run(async (ctx) => ctx.db.query("devices").collect());
    const fresh = rows.find((row) => row.sessionId === renewed!.sessionId);
    expect(fresh?.pairedAt).toBeTypeOf("number");
  });

  test("a new link from the phone isn't paired until a device connects", async () => {
    const a = await accountWithComputer("alice@example.com");
    const codeHash = "c".repeat(64);
    await a.phone.mutation(api.devices.createLink, { codeHash });
    const linked = await t.mutation(internal.devices.redeem, { codeHash, name: "LAPTOP" });
    const rows = await t.run(async (ctx) => ctx.db.query("devices").collect());
    expect(rows.find((row) => row.sessionId === linked!.sessionId)?.pairedAt).toBeUndefined();
  });
});
