import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { isOwnerIdentity, OWNER_USER_ID, type OwnerIdentityRow } from './ownerIdentity.js';

/**
 * NEURAL TWIN IS PARKED — owner decision, Nov 9.
 *
 * Twin is not deleted and not disabled: its renderer (a vector face drawn from
 * facial DNA, one still per segment, no background, no full body) is under
 * active rebuild and the owner keeps testing it in her own account. What is
 * closed is the client door.
 *
 * Why the rule lives here and not only in the Studio UI: hiding a box is not the
 * same as closing a door. A client with an old page still open, or anyone who
 * calls the API directly, would otherwise still reach the renderer and get a
 * video we have told them nothing about. So the refusal is enforced on the
 * server, in front of every Twin render, and it is a plain sentence — not a 500,
 * not a silent no-op.
 *
 * The owner is identified by the ONE rule in services/ownerIdentity.ts (seeded
 * zero-UUID / owner email / OWNER_MASTER tier), never by a second copy of it.
 */

export const TWIN_PARKED_CODE = 'TWIN_UNAVAILABLE';

/** What a client is told. Plain words, no internals, and it says what still works. */
export const TWIN_PARKED_MESSAGE =
  'Neural Twin videos are paused for now while we rebuild them. Scene-Based and Faceless videos still work exactly as before, and nothing else in your account has changed.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure decision over a resolved identity row. Owner ⇒ Twin stays reachable. */
export function twinAllowedForIdentity(row: OwnerIdentityRow | null | undefined): boolean {
  return isOwnerIdentity(row);
}

/** The body a refused caller receives (controllers return it with 403). */
export function twinRefusalBody() {
  return { status: 'error' as const, error: TWIN_PARKED_MESSAGE, code: TWIN_PARKED_CODE };
}

/**
 * May this user still render a Twin? Fails CLOSED: an empty, sentinel, non-uuid
 * or unreadable identity is never the owner, so it is refused. A DB failure must
 * never open the door.
 */
export async function isTwinAllowedForUser(userId: string | null | undefined): Promise<boolean> {
  const id = String(userId ?? '').trim();
  if (!UUID_RE.test(id)) return false;
  // The seeded owner UUID identifies the owner on its own (isOwnerIdentity
  // returns true for it without any row), so Twin stays open to her even if the
  // identity read below cannot complete.
  if (id.toLowerCase() === OWNER_USER_ID) return true;
  try {
    const [row] = await db
      .select({ id: schema.users.id, email: schema.users.email, tier: schema.users.tier })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    return twinAllowedForIdentity(row);
  } catch {
    return false;
  }
}

/**
 * Thrown by the Twin renderer when a non-owner asks for a Twin video. Typed so
 * every entry point can answer 403 + TWIN_PARKED_MESSAGE instead of a 500.
 */
export class TwinUnavailableError extends Error {
  readonly code = TWIN_PARKED_CODE;
  constructor(message: string = TWIN_PARKED_MESSAGE) {
    super(message);
    this.name = 'TwinUnavailableError';
  }
}

/** True when an unknown error is the parked-Twin refusal. */
export function isTwinUnavailableError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as any).code === TWIN_PARKED_CODE;
}
