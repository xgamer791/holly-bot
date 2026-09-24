// Where this computer's bots are kept, and the app that runs them. Linked to a
// Holly Bot account (computer/src/account.mjs), they're kept in the account,
// like the app keeps its own (src/account/cloud-db.js), and this computer runs
// them around the clock. Until it's linked, they're kept in its data folder
// (NodeDB). Linking moves what the folder holds into the account.
//
// The app behind the server can change (linked, unlinked, reloaded after
// another device changed the account); `onSwap` hands the new one over, and
// phones reload their state from it.

import { existsSync, renameSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeDB } from './node-db.mjs';
import { FileOutbox } from './outbox.mjs';
import { App } from '../../src/core/app.js';
import { SCHEMA } from '../../src/core/db.js';
import { CloudDB } from '../../src/account/cloud-db.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BotHome {
  constructor({ dataDir, account, computer, log = console }) {
    this.dataDir = dataDir;
    this.account = account;
    this.computer = computer;
    this.log = log;
    this.app = null;
    this.busy = null; // a link, unlink or reload under way
    this.onSwap = () => {};
    account.onEnded = () => this.linkEnded();
  }

  localDir() {
    return join(this.dataDir, 'data');
  }

  outboxDir(userId) {
    return join(this.dataDir, `outbox-${userId}`);
  }

  status() {
    return { linked: this.account.linked, userId: this.account.userId };
  }

  /** Starts the app from wherever the bots are kept. */
  async open() {
    this.app = await this.build(this.account.linked ? await this.openAccount() : await NodeDB.open(this.localDir()));
    const renew = () => this.account.renewIfDue().catch((err) => this.log.warn?.(`  Renewing the link to your Holly Bot account: ${err.message}`));
    renew();
    this.renewTimer = setInterval(renew, 24 * 60 * 60 * 1000);
    this.renewTimer.unref();
    return this.app;
  }

  /** The account's storage. At startup it waits for the server if it can't
   * be reached (the bots are in the account, so there's nothing to run
   * without it); `once` gives up after the first try instead. */
  async openAccount({ once = false } = {}) {
    for (let wait = 5000; ; wait = Math.min(wait * 2, 60_000)) {
      const userId = this.account.userId;
      if (!userId) return NodeDB.open(this.localDir()); // the link ended meanwhile
      try {
        return await CloudDB.open({
          userId,
          call: (kind, name, args) => this.account.authed(kind, name, args),
          outbox: await FileOutbox.open(this.outboxDir(userId)),
        });
      } catch (err) {
        if (once) throw err;
        if (!this.account.linked) return NodeDB.open(this.localDir());
        this.log.log?.(`  Can't reach your Holly Bot account (${err.message}). Trying again in ${Math.round(wait / 1000)}s…`);
        await sleep(wait);
      }
    }
  }

  async build(db) {
    const app = await App.create({ db, computer: this.computer, host: 'computer' });
    if (db.cloud) {
      db.onError = (message) => this.log.warn?.(`  ${message}`);
      db.onStale = () => this.reloadWhenIdle();
      if (db.stale) this.reloadWhenIdle();
    }
    await app.start();
    app.startScheduler();
    return app;
  }

  /** Puts `next` in charge and retires the app it replaces. */
  swap(next) {
    const old = this.app;
    this.app = next;
    this.onSwap(next);
    if (old && old !== next) {
      old.stopScheduler();
      old.runtime.stopAll();
    }
  }

  /**
   * Links this computer to the account a code from the app was made for, moves
   * what its folder holds into the account, and runs the bots from there. The
   * folder is kept, renamed, in case anything needs looking up. If anything
   * fails, nothing changes: the bots keep running from the folder.
   */
  async link(code) {
    if (this.busy) throw new Error('Holly Computer is busy. Try again in a minute.');
    if (this.account.linked) throw new Error('This computer is already linked to a Holly Bot account.');
    this.busy = 'link';
    const local = this.app.db;
    let cloud = null;
    try {
      await this.account.link(code);
      cloud = await this.openAccount({ once: true });
      this.app.stopScheduler();
      this.app.runtime.stopAll();
      await moveInto(local, cloud);
      this.swap(await this.build(cloud));
    } catch (err) {
      await cloud?.discard?.().catch(() => {});
      if (this.account.linked) await this.account.unlink().catch(() => {});
      this.app.startScheduler();
      this.busy = null;
      throw err;
    }
    // Linked. The old folder is set aside, not deleted.
    let aside = null;
    try {
      local.close?.();
      if (existsSync(this.localDir())) {
        aside = join(this.dataDir, `data-before-account-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        renameSync(this.localDir(), aside);
      }
    } catch (err) {
      aside = null;
      this.log.warn?.(`  Couldn't set aside the old data folder: ${err.message}`);
    }
    this.busy = null;
    this.log.log?.('\n  This computer keeps its bots in your Holly Bot account now.');
    if (aside) this.log.log?.(`  What it kept before is set aside in ${aside}. Delete it once you've checked your bots are all there.`);
    this.log.log?.('');
    return this.status();
  }

  /** Unlinks from the account. The bots stay in the account; this computer
   * sends what's left, ends its session, forgets what it kept of the
   * account, and starts again with an empty folder. */
  async unlink() {
    if (this.busy) throw new Error('Holly Computer is busy. Try again in a minute.');
    if (!this.account.linked) return this.status();
    this.busy = 'unlink';
    try {
      const { userId } = this.account;
      this.app.stopScheduler();
      this.app.runtime.stopAll();
      await this.app.db.close?.({ timeout: 10_000 });
      await this.account.unlink();
      await rm(this.outboxDir(userId), { recursive: true, force: true });
      await this.forgetAccountFiles();
      this.swap(await this.build(await NodeDB.open(this.localDir())));
      this.log.log?.('\n  This computer is no longer linked to a Holly Bot account.\n');
      return this.status();
    } finally {
      this.busy = null;
    }
  }

  /** The server ended the link (unlinked from the app, or the account was
   * deleted): stop using the account, forget it here, and start again with an
   * empty folder. */
  linkEnded() {
    if (this.busy) {
      setTimeout(() => this.linkEnded(), 5000).unref();
      return;
    }
    if (this.account.linked) return; // linked again meanwhile
    this.busy = 'ended';
    (async () => {
      if (this.app?.db?.cloud) {
        await this.app.db.discard();
        this.swap(await this.build(await NodeDB.open(this.localDir())));
        this.log.log?.('\n  This computer was unlinked from its Holly Bot account. Open Holly Bot on your phone to link it again.\n');
      }
      await this.forgetAccountFiles();
    })().catch((err) => this.log.warn?.(`  Leaving the account: ${err.message}`)).finally(() => {
      this.busy = null;
    });
  }

  /** Removes what this computer kept of any account (unsent changes). */
  async forgetAccountFiles() {
    for (const name of await readdir(this.dataDir)) {
      if (name.startsWith('outbox-')) await rm(join(this.dataDir, name), { recursive: true, force: true });
    }
  }

  /** Another device changed the account: load it again once nothing is
   * running and nothing is waiting to be saved. */
  reloadWhenIdle() {
    if (this.reloadTimer) return;
    const attempt = async () => {
      this.reloadTimer = null;
      const app = this.app;
      if (!app?.db?.cloud) return;
      if (this.busy || app.runtime.activeRuns().length || app.db.pending.length) {
        this.reloadTimer = setTimeout(attempt, 5000);
        this.reloadTimer.unref();
        return;
      }
      this.busy = 'reload';
      try {
        app.stopScheduler();
        await app.db.close({ timeout: 10_000 });
        this.swap(await this.build(await this.openAccount()));
      } catch (err) {
        this.log.warn?.(`  Reloading your bots from your account: ${err.message}`);
        app.startScheduler();
      } finally {
        this.busy = null;
      }
    };
    this.reloadTimer = setTimeout(attempt, 1000);
    this.reloadTimer.unref();
  }

  async close() {
    clearInterval(this.renewTimer);
    clearTimeout(this.reloadTimer);
    const app = this.app;
    if (!app) return;
    app.stopScheduler();
    app.runtime.stopAll();
    await app.db.close?.({ timeout: 5000 });
  }
}

/** Copies everything in this computer's folder into the account, keeping the
 * account's own settings where both have them, then waits until the server
 * has all of it. */
async function moveInto(local, cloud) {
  for (const store of Object.keys(SCHEMA)) {
    let rows = await local.all(store);
    if (store === 'kv') rows = (await Promise.all(rows.map(async (row) => mergeKv(row, await cloud.get('kv', row.key))))).filter(Boolean);
    for (let i = 0; i < rows.length; i += 200) await cloud.putMany(store, await Promise.all(rows.slice(i, i + 200).map(inMemory)));
  }
  await cloud.drain(10 * 60_000).catch(() => {});
  if (cloud.pending.length) throw new Error("Not everything reached your account yet. Check this computer's internet connection and try again.");
}

/** A row with its file contents read into memory: NodeDB hands out Blobs
 * read from its folder, which is set aside once the move is done. */
async function inMemory(row) {
  let out = row;
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Blob) {
      if (out === row) out = { ...row };
      out[k] = new Blob([await v.arrayBuffer()], { type: v.type });
    }
  }
  return out;
}

/** A setting from this computer next to the account's copy (if it has one). */
function mergeKv(row, existing) {
  if (!existing) return row;
  if (row.key !== 'settings') return null; // the account's own (usage…) stays
  return { ...existing, value: mergeSettings(existing.value, row.value) };
}

/** The account's settings, plus the API keys and plugins only this computer had. */
export function mergeSettings(account = {}, computer = {}) {
  const out = structuredClone(account || {});
  for (const group of ['providers', 'services']) {
    for (const [id, conf] of Object.entries(computer?.[group] || {})) {
      if (conf?.apiKey && !out[group]?.[id]?.apiKey) out[group] = { ...out[group], [id]: { ...out[group]?.[id], ...conf } };
    }
  }
  for (const list of ['mcpServers', 'skills']) {
    const idOf = (item) => item?.id ?? JSON.stringify(item);
    const have = new Set((out[list] || []).map(idOf));
    const extra = (computer?.[list] || []).filter((item) => !have.has(idOf(item)));
    if (extra.length) out[list] = [...(out[list] || []), ...extra];
  }
  return out;
}
