import { memoryTools } from './memory-tools.js';
import { interactionTools, agentTools } from './agent-tools.js';
import { fileTools } from './file-tools.js';
import { codeTools } from './code-tools.js';
import { webTools } from './web-tools.js';
import { routineTools } from './routine-tools.js';
import { computerTools } from './computer-tools.js';
import { imageTools } from './image-tools.js';
import { skillTools } from './skill-tools.js';
import { connectorTools } from './connector-tools.js';
import { mcpResultToTool, mcpToolName } from '../mcp.js';
import { truncate } from '../util.js';

export const BUILTIN_TOOLS = [
  ...interactionTools,
  ...memoryTools,
  ...agentTools,
  ...webTools,
  ...codeTools,
  ...fileTools,
  ...routineTools,
  ...imageTools,
  ...computerTools,
  ...connectorTools,
  ...skillTools,
];

/** Tool groups enabled for a bot (bot overrides fall back to defaults). */
export function enabledGroups(agent) {
  return { core: true, ...(agent.tools || {}) };
}

/**
 * Tools this bot can use right now.
 * @param {object} app
 * @param {object} agent
 * @param {{ nativeSearch?: boolean }} opts - provider already has server-side web search
 */
export function toolsForAgent(app, agent, { nativeSearch = false } = {}) {
  const groups = enabledGroups(agent);
  const isOn = (g) => g === 'core' || groups[g] !== false;
  const tools = BUILTIN_TOOLS.filter((t) => {
    if (!isOn(t.group)) return false;
    if (t.available && !t.available(app, agent)) return false;
    // Skip our client search when the provider searches natively (fetch_url stays).
    if (t.name === 'web_search' && nativeSearch) return false;
    if (t.name === 'list_agents' && app.listAgents().length < 2) return false;
    return true;
  });
  if (isOn('plugins')) tools.push(...app.plugins.toolsFor(agent));
  return tools;
}

/** Build tool definitions from a connected MCP server's tool list. */
export function mcpTools(serverName, list, call, { via = 'direct' } = {}) {
  return list.map((t) => ({
    name: mcpToolName(serverName, t.name),
    group: 'plugins',
    plugin: serverName,
    label: () => `${serverName}: ${t.title || t.annotations?.title || t.name}`,
    description: truncate(`[${serverName} plugin${via === 'computer' ? ' via Bot Computer' : ''}] ${t.description || t.name}`, 1000),
    parameters: normalizeSchema(t.inputSchema),
    risk: t.annotations?.readOnlyHint ? 'low' : 'high',
    approval: (a) => `${serverName} → ${t.name} ${truncate(JSON.stringify(a), 120)}`,
    async run(args, ctx) {
      const result = await call(t.name, args, { signal: ctx.signal });
      const r = mcpResultToTool(result);
      return { ...r, display: { kind: 'plugin', server: serverName, tool: t.name } };
    },
  }));
}

function normalizeSchema(s) {
  if (!s || typeof s !== 'object') return { type: 'object', properties: {} };
  const out = { ...s, type: 'object' };
  if (!out.properties) out.properties = {};
  return out;
}

/** Light JSON-schema check of tool arguments (required keys + primitive types). */
export function validateArgs(schema, args) {
  if (!schema || typeof schema !== 'object') return null;
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be a JSON object';
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return `missing required argument "${key}"`;
  }
  for (const [key, def] of Object.entries(schema.properties || {})) {
    const v = args[key];
    if (v === undefined || v === null || !def?.type) continue;
    const types = Array.isArray(def.type) ? def.type : [def.type];
    const ok = types.some((t) => (t === 'integer' ? Number.isInteger(v) || (typeof v === 'string' && /^-?\d+$/.test(v))
      : t === 'number' ? typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))
        : t === 'array' ? Array.isArray(v)
          : t === 'object' ? typeof v === 'object' && !Array.isArray(v)
            : t === 'boolean' ? typeof v === 'boolean' || v === 'true' || v === 'false'
              : typeof v === t));
    if (!ok) return `argument "${key}" should be ${types.join(' or ')}`;
    if (def.enum && !def.enum.includes(v)) return `argument "${key}" must be one of: ${def.enum.join(', ')}`;
  }
  return null;
}

/** Coerce stringly-typed numbers/booleans some models emit. */
export function coerceArgs(schema, args) {
  if (!schema?.properties || !args || typeof args !== 'object') return args;
  const out = { ...args };
  for (const [key, def] of Object.entries(schema.properties)) {
    const v = out[key];
    if (typeof v !== 'string') continue;
    if (def.type === 'integer' && /^-?\d+$/.test(v)) out[key] = parseInt(v, 10);
    else if (def.type === 'number' && v.trim() && !Number.isNaN(Number(v))) out[key] = Number(v);
    else if (def.type === 'boolean' && (v === 'true' || v === 'false')) out[key] = v === 'true';
    else if (def.type === 'array' && v.trim().startsWith('[')) {
      try {
        out[key] = JSON.parse(v);
      } catch { /* leave */ }
    } else if (def.type === 'array' && def.items?.type === 'string') {
      // "a@x.com, b@y.com" for ["a@x.com", "b@y.com"]
      out[key] = v.split(',').map((item) => item.trim()).filter(Boolean);
    } else if (def.type === 'object' && v.trim().startsWith('{')) {
      try {
        out[key] = JSON.parse(v);
      } catch { /* leave */ }
    }
  }
  return out;
}
