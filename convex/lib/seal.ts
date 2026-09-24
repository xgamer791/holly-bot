// Connection tokens at rest (convex/connectors.ts): AES-256-GCM with
// CONNECTORS_KEY, 32 random bytes in base64 that only the deployment holds
// (scripts/convex-connectors-key.mjs makes it). A sealed value reads
// "v1.<iv>.<ciphertext>", and `context` (the account and service it belongs
// to) is bound in, so a sealed value moved to another row won't open. No
// imports: the tests load this file straight into Node.

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(keyB64: string | undefined): Promise<CryptoKey> {
  const raw = keyB64 ? fromBase64(keyB64.trim()) : new Uint8Array();
  if (raw.length !== 32) throw new Error("CONNECTORS_KEY must be 32 random bytes in base64");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(keyB64: string | undefined, value: unknown, context: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, key, data));
  return `v1.${toBase64Url(iv)}.${toBase64Url(sealed)}`;
}

export async function unseal<T = any>(keyB64: string | undefined, sealed: string, context: string): Promise<T> {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("Not a sealed value");
  const key = await importKey(keyB64);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv), additionalData: new TextEncoder().encode(context) }, key, fromBase64(data));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
