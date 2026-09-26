// The computers linked to the user's Holly Bot account (convex/devices.ts
// list), as the app and the bots see them: what each is doing, from what it
// last told the account. Shared by the app (src/main.js, src/remote) and
// Holly Bot Computer (computer/src/home.mjs), which tell the bots
// (src/core/prompts.js Your computers).

/** A linked computer says it's running every five minutes
 * (computer/src/home.mjs); one not heard from for longer than this is off. */
export const RUNNING_MS = 12 * 60_000;

/**
 * What a computer linked to the account (convex/devices.ts `list`) is doing:
 * 'running' where the account's devices can reach it; 'hidden', running with
 * no address they can reach (no --tunnel or --public-url, or its tunnel isn't
 * working: `tunnel` says why); 'off', stopped or not heard from lately; or
 * 'old', never heard from (a Holly Bot Computer older than 1.8.0, which doesn't say).
 */
export function computerState(device, now = Date.now()) {
  if (!device?.seenAt) return 'old';
  if (device.stoppedAt || now - device.seenAt > RUNNING_MS) return 'off';
  return device.url && device.access ? 'running' : 'hidden';
}

/**
 * A linked computer as the bots hear of it: its name, whether it's the
 * server that comes with the plan, its system ('win32', 'darwin', 'linux')
 * when it said, and what it's doing (computerState, with 'starting' or
 * 'blocked' for one running whose tunnel isn't working yet or can't). Never
 * its address or key. `here`: the computer the bots are working on.
 */
export function computerSummary(device, { here = false, now = Date.now() } = {}) {
  const state = computerState(device, now);
  return {
    id: device.id,
    name: device.name,
    server: !!device.server,
    ...(device.platform ? { platform: device.platform } : {}),
    state: state === 'hidden' && ['starting', 'blocked'].includes(device.tunnel) ? device.tunnel : state,
    ...(here ? { here: true } : {}),
  };
}
