/**
 * PASSWORD HASHING (owner, Nov 27 — authentication first).
 *
 * The old scheme was unsalted pbkdf2, 1000 iterations, ONE hardcoded salt for
 * every user (`'empire-launch-salt'`, 128 hex chars stored). That is a rainbow
 * table away from useless, and a shared salt means two users with the same
 * password had identical rows.
 *
 * The new scheme is scrypt (Node's own `crypto`, no new dependency):
 *
 *     scrypt$<N>$<saltHex>$<hashHex>
 *
 *   - 16 random bytes of salt per user,
 *   - N = 16384, r = 8, p = 1, 64-byte derived key,
 *   - constant-time comparison (`timingSafeEqual`).
 *
 * `verifyPassword` still accepts the OLD format so nobody is locked out: on a
 * successful legacy login it reports `needsRehash`, and the caller rewrites the
 * row in the new format. Once rehashed, the old scheme is unreachable for that
 * account — a new hash is never written in the old format.
 */
import crypto from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_BYTES = 16;
// N=16384, r=8 needs ~16MB by default; ask for 64MB so the default cap never bites.
const MAX_MEM = 64 * 1024 * 1024;

/** The legacy salt every old row used. Only ever read, never written again. */
const LEGACY_SALT = 'empire-launch-salt';
const LEGACY_ITERATIONS = 1000;
const LEGACY_KEY_LEN = 64;

const pbkdf2 = promisify(crypto.pbkdf2);

/** Hash a password in the current format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(String(password), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** The old 128-hex-char pbkdf2 hash (no scheme prefix). */
export function isLegacyHash(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && /^[0-9a-f]{128}$/i.test(stored);
}

export function isCurrentHash(stored: string | null | undefined): boolean {
  return typeof stored === 'string' && stored.startsWith('scrypt$');
}

/**
 * Verify a password against a stored hash.
 *
 *   { ok: false }                      — wrong password, or no usable hash
 *   { ok: true, needsRehash: false }   — current format, nothing to do
 *   { ok: true, needsRehash: true }    — legacy hash verified: the caller MUST
 *                                        rewrite the row with `hashPassword`
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (typeof stored !== 'string' || !stored) return { ok: false, needsRehash: false };

  if (isCurrentHash(stored)) {
    const parts = stored.split('$');
    if (parts.length !== 4) return { ok: false, needsRehash: false };
    const [, rawN, saltHex, hashHex] = parts;
    const n = Number(rawN);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, needsRehash: false };
    const salt = Buffer.from(saltHex, 'hex');
    if (!salt.length) return { ok: false, needsRehash: false };

    const derived = await scrypt(String(password), salt, hashHex.length / 2, {
      N: n,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: MAX_MEM,
    });
    const ok = safeEqualHex(derived.toString('hex'), hashHex);
    return { ok, needsRehash: false };
  }

  if (isLegacyHash(stored)) {
    const derived = await pbkdf2(String(password), LEGACY_SALT, LEGACY_ITERATIONS, LEGACY_KEY_LEN, 'sha512');
    const ok = safeEqualHex(derived.toString('hex'), stored.toLowerCase());
    return { ok, needsRehash: ok };
  }

  // An unknown format is not a password match.
  return { ok: false, needsRehash: false };
}
