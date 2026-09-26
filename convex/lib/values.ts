// Values Convex takes back from a function. Its objects' field names can't
// start with "$", hold only printable ASCII and run to 1024 characters at most;
// arrays hold up to 8192 items and objects 1024 fields, 64 levels deep. What a
// connected service sends can break that (a tool's JSON Schema with "$schema"
// and "$defs", a GitHub reply), and then the call fails after it's done, as a
// bare "Server Error" nothing can explain. convexSafe makes any JSON value one
// Convex takes, changing only what it has to. No imports.

const MAX_NAME = 1024;
const MAX_ITEMS = 8192;
const MAX_FIELDS = 1024;
const MAX_DEPTH = 60;

/** A field name Convex takes: "$ref" → "_$ref", "café" → "café". */
function safeName(name: string): string {
  let out = name.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (out.startsWith("$")) out = `_${out}`;
  return (out || "_").slice(0, MAX_NAME);
}

/** `value` (plain JSON) as Convex takes it. What's nested too deep for it comes as JSON text. */
export function convexSafe(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return JSON.stringify(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => convexSafe(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(value).slice(0, MAX_FIELDS)) {
    let key = safeName(name);
    while (key in out) key = `${key}_`;
    out[key] = convexSafe(v, depth + 1);
  }
  return out;
}
