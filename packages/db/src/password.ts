import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Stored format: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>. The parameters are inside the string,
// so they can be raised later without breaking old hashes.
const COST = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Never throws on a malformed stored value: it just says "no". */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const options = { N: Number(n), r: Number(r), p: Number(p) };
  if (![options.N, options.r, options.p].every(Number.isSafeInteger)) return false;
  try {
    const expected = Buffer.from(hash, "base64");
    const actual = await derive(password, Buffer.from(salt, "base64"), options);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
