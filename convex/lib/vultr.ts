// Vultr's API (v2), for subscribers' dedicated servers (convex/servers.ts):
// plain functions over fetch. A call that fails for a reason worth another
// try (the network, a rate limit, a 5xx) is tried again up to three times,
// waiting longer each time. With VULTR_DRY_RUN=true nothing is sent: each
// call is logged instead, and made-up answers stand in, so the whole flow can
// be tried in Stripe test mode without a server being made. No imports.

type Fetch = typeof fetch;

const API = "https://api.vultr.com/v2";
const RETRIES = 3;
const BACKOFF_MS = [1_000, 3_000, 9_000];

/** Vultr turned a request down, or couldn't be reached (`status` 0). */
export class VultrError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface Instance {
  id: string;
  label: string;
  tags: string[];
  /** Its Vultr plan, e.g. vc2-2c-4gb. */
  plan: string;
  /** Its public IPv4 address, or "" until Vultr has given it one. */
  ip: string;
  /** pending, active, suspended or resizing. */
  status: string;
  /** running or stopped. */
  power: string;
  /** none, locked, installingbooting or ok. */
  state: string;
}

export interface NewInstance {
  region: string;
  plan: string;
  osId: number;
  label: string;
  tag: string;
  hostname: string;
  /** The cloud-init script, as text (it's sent base64-encoded). */
  userData: string;
  /** Servers already known, which a lost answer can't have been. */
  exclude?: string[];
}

export interface Vultr {
  dryRun: boolean;
  /** The os_id of the newest x64 image whose name starts with `name`. */
  osId(name: string): Promise<number>;
  create(o: NewInstance): Promise<Instance>;
  /** null when there's no such server. */
  get(id: string): Promise<Instance | null>;
  resize(id: string, plan: string): Promise<void>;
  /** False when it was already gone (404). */
  remove(id: string): Promise<boolean>;
  list(filter: { tag?: string; label?: string }): Promise<Instance[]>;
}

export interface VultrOptions {
  key?: string;
  dryRun: boolean;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** The deployment's Vultr settings: VULTR_API_KEY and VULTR_DRY_RUN. */
export function vultrSettings(env: Record<string, string | undefined>): { key?: string; dryRun: boolean } {
  return { key: env.VULTR_API_KEY?.trim() || undefined, dryRun: /^(1|true|yes|on)$/i.test(env.VULTR_DRY_RUN?.trim() ?? "") };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function toInstance(raw: any): Instance {
  const ip = typeof raw?.main_ip === "string" && raw.main_ip && raw.main_ip !== "0.0.0.0" ? raw.main_ip : "";
  return {
    id: String(raw?.id ?? ""),
    label: String(raw?.label ?? ""),
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : raw?.tag ? [String(raw.tag)] : [],
    plan: String(raw?.plan ?? ""),
    ip,
    status: String(raw?.status ?? ""),
    power: String(raw?.power_status ?? ""),
    state: String(raw?.server_status ?? ""),
  };
}

const retryable = (status: number) => status === 0 || status === 429 || status >= 500;
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A Vultr client, or null when there's no API key and it isn't a dry run. */
export function connect(o: VultrOptions): Vultr | null {
  if (!o.key && !o.dryRun) return null;
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = o.log ?? ((line: string) => console.log(line));

  /** One request, without retries. */
  const once = async (method: string, path: string, body?: unknown): Promise<any> => {
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${o.key}`, ...(body ? { "Content-Type": "application/json" } : null) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new VultrError(`Couldn't reach Vultr: ${describe(err)}`, 0);
    }
    const data: any = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new VultrError(data?.error || `Vultr answered ${res.status}`, res.status);
    return data;
  };

  /** A request, tried again up to three times while it fails for a reason
   * worth another try. `before` runs ahead of each retry and can settle it
   * (a server made after all, though its answer was lost). */
  const request = async (method: string, path: string, body?: unknown, before?: () => Promise<any>): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(method, path, body);
      } catch (err) {
        if (!(err instanceof VultrError) || !retryable(err.status) || attempt >= RETRIES) throw err;
        log(`Vultr: ${method} ${path} failed (${err.message}); trying again (${attempt + 1} of ${RETRIES})`);
        await sleep(BACKOFF_MS[attempt]);
        const settled = await before?.();
        if (settled) return settled;
      }
    }
  };

  const listPath = (filter: { tag?: string; label?: string }, cursor?: string) => {
    const q = new URLSearchParams({ per_page: "500" });
    if (filter.tag) q.set("tag", filter.tag);
    if (filter.label) q.set("label", filter.label);
    if (cursor) q.set("cursor", cursor);
    return `/instances?${q}`;
  };

  const list = async (filter: { tag?: string; label?: string }): Promise<Instance[]> => {
    const out: Instance[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const data = await request("GET", listPath(filter, cursor));
      out.push(...(data?.instances ?? []).map(toInstance));
      cursor = data?.meta?.links?.next || undefined;
      if (!cursor) break;
    }
    return out;
  };

  if (o.dryRun) {
    const say = (line: string) => log(`Vultr dry run (nothing sent): ${line}`);
    const made = () => `dry-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    return {
      dryRun: true,
      async osId(name) {
        say(`GET /os, for the os_id of ${name} x64`);
        return 0;
      },
      async create(n) {
        const id = made();
        say(`POST /instances ${JSON.stringify({ region: n.region, plan: n.plan, os_id: n.osId, label: n.label, tags: [n.tag], hostname: n.hostname, backups: "disabled", user_data: `(${n.userData.length} characters of cloud-init, base64-encoded)` })} → ${id}`);
        return { id, label: n.label, tags: [n.tag], plan: n.plan, ip: "", status: "pending", power: "running", state: "none" };
      },
      async get(id) {
        say(`GET /instances/${id}`);
        return { id, label: "", tags: [], plan: "", ip: "192.0.2.1", status: "active", power: "running", state: "ok" };
      },
      async resize(id, plan) {
        say(`PATCH /instances/${id} ${JSON.stringify({ plan })}`);
      },
      async remove(id) {
        say(`DELETE /instances/${id}`);
        return true;
      },
      async list(filter) {
        say(`GET ${listPath(filter)}`);
        return [];
      },
    };
  }

  return {
    dryRun: false,
    async osId(name) {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const data = await request("GET", `/os?per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        const os = (data?.os ?? []).find((item: any) => String(item?.name ?? "").startsWith(name) && item?.arch === "x64");
        if (os) return Number(os.id);
        cursor = data?.meta?.links?.next || undefined;
        if (!cursor) break;
      }
      throw new VultrError(`Vultr has no ${name} x64 image`, 404);
    },
    async create(n) {
      const body = {
        region: n.region,
        plan: n.plan,
        os_id: n.osId,
        label: n.label,
        tags: [n.tag],
        hostname: n.hostname,
        user_data: toBase64(n.userData),
        // Backups and snapshots cost extra, and a subscriber's bots are kept
        // in their Holly Bot account anyway.
        backups: "disabled",
        activation_email: false,
      };
      // Creating isn't safe to repeat blindly: if Vultr made the server but
      // its answer was lost, the retry would make a second one. So before
      // each retry, look for a server with this label first.
      const found = async () => (await list({ label: n.label }).catch(() => [])).find((i) => i.label === n.label && !n.exclude?.includes(i.id));
      const data = await request("POST", "/instances", body, async () => {
        const instance = await found();
        return instance ? { instance: { ...instance, main_ip: instance.ip, power_status: instance.power, server_status: instance.state } } : null;
      });
      return toInstance(data?.instance);
    },
    async get(id) {
      try {
        return toInstance((await request("GET", `/instances/${encodeURIComponent(id)}`))?.instance);
      } catch (err) {
        if (err instanceof VultrError && err.status === 404) return null;
        throw err;
      }
    },
    async resize(id, plan) {
      await request("PATCH", `/instances/${encodeURIComponent(id)}`, { plan });
    },
    async remove(id) {
      try {
        await request("DELETE", `/instances/${encodeURIComponent(id)}`);
        return true;
      } catch (err) {
        if (err instanceof VultrError && err.status === 404) return false;
        throw err;
      }
    },
    list,
  };
}
