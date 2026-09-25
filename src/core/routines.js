import { uid, now } from './util.js';
import { range } from './db.js';

// Routine schedules and storage. Times are interpreted in the user's time
// zone (app.timeZone(): the one their device is in, found automatically).

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Offset (ms) of `tz` from UTC at instant `ts` (positive east of UTC). */
export function tzOffset(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(ts / 1000) * 1000;
}

/** Wall-clock parts of `ts` in `tz`. */
export function zonedParts(ts, tz) {
  const d = new Date(ts + tzOffset(ts, tz));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}

/** UTC timestamp for a wall-clock time in `tz` (handles DST by re-checking the offset). */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m, d, hh, mm);
  let ts = guess - tzOffset(guess, tz);
  const off2 = tzOffset(ts, tz);
  ts = guess - off2;
  return ts;
}

export function parseTime(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) throw new Error(`time must look like 08:30 (got "${s}")`);
  let hh = +m[1];
  const mm = +(m[2] || 0);
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'pm';
    if (hh === 12) hh = pm ? 12 : 0;
    else if (pm) hh += 12;
  }
  if (hh > 23 || mm > 59) throw new Error(`invalid time "${s}"`);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function normalizeSchedule(s, tz = deviceTimeZone()) {
  const kind = s?.kind;
  if (kind === 'once') {
    let at = typeof s.at === 'number' ? s.at : NaN;
    if (typeof s.at === 'string') {
      const str = s.at.trim();
      const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(str);
      const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
      at = !hasZone && m ? zonedToUtc(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], tz) : Date.parse(str);
    }
    if (!Number.isFinite(at)) throw new Error('"at" must be an ISO date-time');
    return { kind, at };
  }
  if (kind === 'interval') {
    const everyMinutes = Math.max(15, Math.round(Number(s.everyMinutes) || 60));
    return { kind, everyMinutes };
  }
  if (kind === 'daily') return { kind, time: parseTime(s.time || '09:00') };
  if (kind === 'weekly') {
    const days = (s.days || []).map((d) => (typeof d === 'number' ? d : DAYS.indexOf(String(d).slice(0, 3).toLowerCase()))).filter((d) => d >= 0 && d <= 6);
    if (!days.length) throw new Error('weekly schedules need at least one day');
    return { kind, time: parseTime(s.time || '09:00'), days: [...new Set(days)].sort() };
  }
  throw new Error('kind must be once, interval, daily or weekly');
}

/** Next run strictly after `from` (null when a one-time routine has passed). */
export function nextRun(schedule, from = now(), tz = deviceTimeZone(), lastRunAt = null) {
  switch (schedule.kind) {
    case 'once':
      return schedule.at > from || !lastRunAt ? schedule.at : null;
    case 'interval': {
      const step = schedule.everyMinutes * 60000;
      return (lastRunAt ? Math.max(lastRunAt + step, from) : from + step);
    }
    case 'daily':
    case 'weekly': {
      const [hh, mm] = schedule.time.split(':').map(Number);
      const p = zonedParts(from, tz);
      for (let i = 0; i < 8; i++) {
        const base = new Date(Date.UTC(p.y, p.m, p.d + i));
        const dow = base.getUTCDay();
        if (schedule.kind === 'weekly' && !schedule.days.includes(dow)) continue;
        const ts = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hh, mm, tz);
        if (ts > from) return ts;
      }
      return null;
    }
    default:
      return null;
  }
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function describeSchedule(s) {
  if (!s) return '';
  switch (s.kind) {
    case 'once': return `Once on ${new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    case 'interval': return s.everyMinutes % 60 === 0 ? `Every ${s.everyMinutes / 60 === 1 ? 'hour' : `${s.everyMinutes / 60} hours`}` : `Every ${s.everyMinutes} min`;
    case 'daily': return `Every day at ${fmtTime(s.time)}`;
    case 'weekly': {
      const names = s.days.map((d) => DAYS[d][0].toUpperCase() + DAYS[d].slice(1));
      const label = s.days.length === 5 && !s.days.includes(0) && !s.days.includes(6) ? 'Weekdays' : names.join(', ');
      return `${label} at ${fmtTime(s.time)}`;
    }
    default: return '';
  }
}

export class RoutineStore {
  constructor({ db, getTimeZone = deviceTimeZone, onChange = () => {} }) {
    this.db = db;
    this.getTimeZone = getTimeZone;
    this.onChange = onChange;
  }

  async list(agentId) {
    const rows = agentId ? await this.db.query('routines', 'byAgent', range.only(agentId)) : await this.db.all('routines');
    return rows.sort((a, b) => (a.nextRunAt || Infinity) - (b.nextRunAt || Infinity));
  }

  get(id) {
    return this.db.get('routines', id);
  }

  async create({ agentId, title, prompt, schedule, enabled = true }) {
    const t = now();
    const r = {
      id: uid('rtn'), agentId, title: String(title).slice(0, 120), prompt: String(prompt).slice(0, 4000), schedule, enabled,
      createdAt: t, updatedAt: t, lastRunAt: null, runCount: 0,
    };
    r.nextRunAt = nextRun(schedule, t, this.getTimeZone());
    await this.db.put('routines', r);
    this.onChange(agentId);
    return r;
  }

  async update(id, patch) {
    const r = await this.get(id);
    if (!r) throw new Error('No such routine');
    const next = { ...r, ...patch, updatedAt: now() };
    if (patch.schedule || (patch.enabled && !r.enabled)) next.nextRunAt = nextRun(next.schedule, now(), this.getTimeZone(), next.lastRunAt);
    await this.db.put('routines', next);
    this.onChange(r.agentId);
    return next;
  }

  async remove(id) {
    const r = await this.get(id);
    await this.db.delete('routines', id);
    if (r) this.onChange(r.agentId);
  }

  async removeForAgent(agentId) {
    await this.db.deleteWhere('routines', 'byAgent', range.only(agentId));
  }

  async due(at = now()) {
    const rows = await this.db.query('routines', 'byNext', IDBKeyRange.upperBound(at));
    return rows.filter((r) => r.enabled && r.nextRunAt);
  }

  async markRan(id, at = now()) {
    const r = await this.get(id);
    if (!r) return null;
    const next = { ...r, lastRunAt: at, runCount: (r.runCount || 0) + 1, updatedAt: at };
    next.nextRunAt = r.schedule.kind === 'once' ? null : nextRun(r.schedule, at, this.getTimeZone(), at);
    if (r.schedule.kind === 'once') next.enabled = false;
    await this.db.put('routines', next);
    this.onChange(r.agentId);
    return next;
  }

  async setAllEnabled(enabled) {
    const all = await this.db.all('routines');
    const t = now();
    const rows = all.filter((r) => r.enabled !== enabled && !(enabled && r.schedule.kind === 'once' && r.lastRunAt)).map((r) => ({
      ...r, enabled, updatedAt: t, nextRunAt: enabled ? nextRun(r.schedule, t, this.getTimeZone(), r.lastRunAt) : r.nextRunAt,
    }));
    await this.db.putMany('routines', rows);
    for (const id of new Set(rows.map((r) => r.agentId))) this.onChange(id);
    return rows.length;
  }
}
