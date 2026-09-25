// Skills: reusable instruction packs the user writes once (Settings → Plugins → Skills)
import { phrase } from '../i18n.js';
// and any bot can load on demand.

export const skillTools = [
  {
    name: 'use_skill',
    group: 'core',
    available: (app) => (app.settings.skills || []).some((s) => s.enabled !== false),
    label: (a) => phrase('Loaded skill “{name}”', { name: a.name }),
    description: 'Load the full instructions of one of the user\'s skills (listed in your instructions) before doing a task it covers.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async run(args, ctx) {
      const skills = (ctx.app.settings.skills || []).filter((s) => s.enabled !== false);
      const skill = skills.find((s) => s.name.toLowerCase() === String(args.name).toLowerCase());
      if (!skill) return { content: `No skill named "${args.name}". Available: ${skills.map((s) => s.name).join(', ') || 'none'}.`, isError: true };
      return { content: `# Skill: ${skill.name}\n\n${skill.instructions}`, display: { kind: 'skill', name: skill.name } };
    },
  },
];
