import { OWNER_CONFIG } from '../config/owner.js';

/**
 * Single source of truth for "is this user the app owner?".
 *
 * Before this module the rule lived inside usageService (quota exemption) and was
 * re-implemented nowhere else — any new owner-gated surface (e.g. the owner-only
 * client-stats endpoint) would have had to copy it, and copies drift. Every owner
 * determination in the backend MUST import from here.
 *
 * The owner is identified three ways, all of which are true of her seeded row:
 *   1. the seeded zero-UUID (provisioned at onboarding),
 *   2. her email (Gmail dot/alias-insensitive, see normalizeOwnerEmail),
 *   3. her provisioned tier (OWNER_MASTER).
 * OWNER_MASTER is deliberately the only tier in the owner set: BETA_TESTER is
 * quota-unlimited but is still a real client account, so it must never be
 * silently dropped from client counts.
 */

/**
 * Gmail (and Googlemail) treat the local part as case-insensitive AND ignore
 * '.' — so first.last@gmail.com, firstlast@gmail.com, First.Last@GMAIL.com are
 * all the same mailbox. The owner's stored email can arrive in any dot-variant
 * depending on how she signed up, so comparison must normalize those away or the
 * exact-string owner check silently fails (real defect — the owner would be
 * counted against client quota). Non-gmail addresses are lowercased only.
 */
export function normalizeOwnerEmail(email: string): string {
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.indexOf('@');
  if (at <= 0) return raw;
  const domain = raw.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const local = raw.slice(0, at).replace(/\./g, '');
    return `${local}@gmail.com`;
  }
  return raw;
}

/** The seeded owner row. Never a client. */
export const OWNER_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Everything the app considers an owner account. Every entry is normalized so
 * Gmail dot-variants collapse to one canonical comparison. OWNER_CONFIG.email is
 * the primary owner email; the .ai address and the dotted variant are kept for
 * robustness against older rows / internal accounts. The owner (Staci) is
 * unlimited on ALL quotas.
 */
export const OWNER_EMAILS: ReadonlySet<string> = new Set([
  normalizeOwnerEmail(OWNER_CONFIG.email),        // stacipeabody@gmail.com (canonical)
  normalizeOwnerEmail('staci.peabody@gmail.com'), // dotted variant -> same mailbox
  normalizeOwnerEmail('staci@empirelaunch.ai'),   // internal .ai account
]);

/** Tiers that are the owner (never a client). See module note re: BETA_TESTER. */
export const OWNER_TIERS: ReadonlySet<string> = new Set(['OWNER_MASTER']);

/** Tiers that are unbounded everywhere else in the codebase (subscriptionGuard,
 *  revenueOracle) — kept here so quota exemption and owner identity cannot drift. */
export const UNLIMITED_TIERS: ReadonlySet<string> = new Set(['OWNER_MASTER', 'BETA_TESTER']);

export interface OwnerIdentityRow {
  id?: string | null;
  email?: string | null;
  tier?: string | null;
}

/** True when the row belongs to the app owner (by id, email or tier). */
export function isOwnerIdentity(row: OwnerIdentityRow | null | undefined): boolean {
  if (!row) return false;
  if (row.id && String(row.id).toLowerCase() === OWNER_USER_ID) return true;
  if (row.tier && OWNER_TIERS.has(row.tier)) return true;
  if (row.email && OWNER_EMAILS.has(normalizeOwnerEmail(row.email))) return true;
  return false;
}
