// Linking Holly Bot Computer to an account (convex/devices.ts). The app makes the
// code and sends the server only its SHA-256; the code itself goes to the
// computer, which trades it for a session of its own. Holly Bot Computer uses the
// same to renew its link (computer/src/account.mjs).

/** A one-time link code and the hex SHA-256 the server keeps of it. */
export async function makeLinkCode() {
  let bin = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) bin += String.fromCharCode(byte);
  const code = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { code, hash };
}
