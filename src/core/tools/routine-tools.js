import { describeSchedule, normalizeSchedule } from '../routines.js';
import { phrase } from '../i18n.js';

// Routines: scheduled prompts a bot runs on its own (while the app is open, or
// on the next launch if a run was missed).

export const routineTools = [
  {
    name: 'schedule_routine',
    group: 'routines',
    label: (a) => phrase('Scheduled “{title}”', { title: a.title }),
    description: 'Create a routine: a task you will run automatically on a schedule (reminders, daily briefings, recurring checks). '
      + 'Schedule kinds: once (at an ISO datetime), interval (every N minutes, min 15), daily (at HH:MM local time), weekly (days + HH:MM). '
      + 'The prompt is what you will be told to do each time, so make it self-contained.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string', description: 'Instructions for each run, e.g. "Check the weather in Austin and send a 3-line morning brief."' },
        kind: { type: 'string', enum: ['once', 'interval', 'daily', 'weekly'] },
        at: { type: 'string', description: 'For once: ISO datetime (local time if no offset).' },
        every_minutes: { type: 'integer', minimum: 15 },
        time: { type: 'string', description: 'For daily/weekly: HH:MM 24h local time.' },
        days: { type: 'array', items: { type: 'string', enum: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] } },
      },
      required: ['title', 'prompt', 'kind'],
    },
    async run(args, ctx) {
      let schedule;
      try {
        schedule = normalizeSchedule({ kind: args.kind, at: args.at, everyMinutes: args.every_minutes, time: args.time, days: args.days });
      } catch (err) {
        return { content: `Invalid schedule: ${err.message}`, isError: true };
      }
      const r = await ctx.app.routines.create({ agentId: ctx.agent.id, title: args.title, prompt: args.prompt, schedule });
      return {
        content: `Routine ${r.id} created: ${describeSchedule(r.schedule)}; next run ${new Date(r.nextRunAt).toLocaleString()}. Runs happen while Holly is open (missed runs catch up on next launch).`,
        display: { kind: 'routine', routineId: r.id, title: r.title, schedule: describeSchedule(r.schedule), plan: r.schedule, nextRunAt: r.nextRunAt },
      };
    },
  },
  {
    name: 'list_routines',
    group: 'routines',
    label: () => phrase('Checked routines'),
    description: 'List your routines with schedules and next run times.',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      const list = await ctx.app.routines.list(ctx.agent.id);
      if (!list.length) return { content: 'No routines yet.' };
      return {
        content: list.map((r) => `- ${r.id}: "${r.title}" — ${describeSchedule(r.schedule)}${r.enabled ? '' : ' (paused)'}; next ${r.nextRunAt ? new Date(r.nextRunAt).toLocaleString() : 'n/a'}\n  prompt: ${r.prompt}`).join('\n'),
      };
    },
  },
  {
    name: 'update_routine',
    group: 'routines',
    label: (a) => (a.delete ? phrase('Deleted a routine') : phrase('Updated a routine')),
    description: 'Pause, resume, edit or delete one of your routines.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        enabled: { type: 'boolean' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        delete: { type: 'boolean' },
      },
      required: ['id'],
    },
    async run(args, ctx) {
      const r = await ctx.app.routines.get(args.id);
      if (!r || r.agentId !== ctx.agent.id) return { content: `No routine ${args.id}.`, isError: true };
      if (args.delete) {
        await ctx.app.routines.remove(args.id);
        return { content: `Deleted routine ${args.id}.` };
      }
      const patch = {};
      for (const k of ['enabled', 'title', 'prompt']) if (args[k] !== undefined) patch[k] = args[k];
      await ctx.app.routines.update(args.id, patch);
      return { content: `Updated routine ${args.id}.` };
    },
  },
];
