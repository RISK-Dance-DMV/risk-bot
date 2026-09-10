/**
 * Discord interaction signature verification.
 *
 * Uses Web Crypto's Ed25519 directly - Workers supports it natively, so there is
 * no tweetnacl dependency and no Node crypto shim.
 */

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("non-hex character");
    out[i] = byte;
  }
  return out;
}

let cachedKey: CryptoKey | null = null;
let cachedKeyHex = "";

async function importPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  if (cachedKey && cachedKeyHex === publicKeyHex) return cachedKey;
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(publicKeyHex),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  cachedKey = key;
  cachedKeyHex = publicKeyHex;
  return key;
}

/**
 * Returns the raw body if the signature is valid, or null if it is not.
 * Returning the body avoids reading the request stream twice.
 */
export async function verifyInteraction(
  request: Request,
  publicKeyHex: string,
): Promise<string | null> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !publicKeyHex) return null;

  const body = await request.text();

  let key: CryptoKey;
  let sig: Uint8Array;
  try {
    key = await importPublicKey(publicKeyHex);
    sig = hexToBytes(signature);
  } catch {
    return null;
  }

  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    sig,
    new TextEncoder().encode(timestamp + body),
  );
  return ok ? body : null;
}

/** Length-independent-ish comparison for shared secrets on inbound webhooks. */
export function secretsMatch(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
