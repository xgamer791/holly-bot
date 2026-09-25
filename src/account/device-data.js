import { DB, SCHEMA } from '../core/db.js';
import { deviceConnection, forgetDeviceConnection, savedConnection, saveConnection } from '../remote/remote-app.js';
import { tr } from '../ui/i18n.js';

// Before Holly Bot had accounts it kept everything in this browser (IndexedDB
// 'holly'), where anyone who signed in on the device could see it. Now it lives
// in each account. What a device still holds from before is offered once to
// whoever signs in there: add it to their account, or delete it. Either way it
// leaves the device.

const LOCAL = 'holly';

async function exists(name) {
  if (typeof indexedDB.databases !== 'function') return true; // can't tell without opening it
  return (await indexedDB.databases()).some((db) => db.name === name);
}

function deleteDatabase(name) {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** What this device kept from before accounts ({ bots, chats, settings, computer }), or null. */
export async function deviceData() {
  const computer = !!deviceConnection();
  if (!(await exists(LOCAL))) return computer ? { bots: 0, chats: 0, settings: false, computer } : null;
  const db = await DB.open(LOCAL);
  let bots = 0;
  let chats = 0;
  let settings = null;
  try {
    bots = await db.count('agents');
    chats = await db.count('threads');
    settings = await db.get('kv', 'settings');
  } finally {
    db.close();
  }
  if (!bots && !chats && !settings && !computer) {
    await deleteDatabase(LOCAL); // opening it to look created an empty one
    return null;
  }
  return { bots, chats, settings: !!settings, computer };
}

/** Adds everything this device kept to the signed-in account (`cloud`, a
 * CloudDB) and, once the server has all of it, removes it from the device.
 * Settings and usage come along only when the account has none yet, so
 * another device's keys are never replaced. */
export async function moveDeviceDataInto(cloud) {
  const local = await DB.open(LOCAL);
  try {
    for (const store of Object.keys(SCHEMA)) {
      let rows = await local.all(store);
      if (store === 'kv') {
        const kept = await Promise.all(rows.map((row) => cloud.get('kv', row.key)));
        rows = rows.filter((row, i) => !kept[i]);
      }
      if (rows.length) await cloud.putMany(store, rows);
    }
  } finally {
    local.close();
  }
  await cloud.drain(5 * 60_000).catch(() => {});
  if (cloud.pending.length) throw new Error(tr("Your bots couldn't all be saved to your account yet. Check your connection and try again."));
  const computer = deviceConnection();
  if (computer && !savedConnection()) saveConnection(computer);
  await forgetDeviceData();
}

export async function forgetDeviceData() {
  forgetDeviceConnection();
  await deleteDatabase(LOCAL);
}
