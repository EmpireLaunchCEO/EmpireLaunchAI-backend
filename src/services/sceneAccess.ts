import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { isOwnerIdentity, OWNER_USER_ID, type OwnerIdentityRow } from './ownerIdentity.js';

/**
 * SCENE-BASED VIDEO IS PARKED — owner decision, Nov 9.
 *
 * Scene is not deleted and not disabled: it is the expensive mode (~$2.63 a
 * video against ~$0.21 for Faceless) and it is being retired into Faceless, so
 * the owner keeps it in her own account while the team finishes that move.
 * What is closed is the client door.
 *
 * Why the rule lives here and not only in the Studio UI: hiding a box is not the
 * same as closing a door. A client with an old page still open, or anyone who
 * calls the API directly, would otherwise still reach the renderer and spend
 * real money on a mode we have told them nothing about. So the refusal is
 * enforced on the server, in front of every Scene render, and it is a plain
 * sentence — not a 500, not a silent no-op.
 *
 * The owner is identified by the ONE rule in services/ownerIdentity.ts (seeded
 * zero-UUID / owner email / OWNER_MASTER tier), never by a second copy of it.
 */

export const SCENE_PARKED_CODE = 'SCENE_UNAVAILABLE';

/** What a client is told. Plain words, no internals, and it says what still works. */
export const SCENE_PARKED_MESSAGE =
  'Scene-Based videos are paused for now. Faceless videos still work exactly as before, and nothing else in your account has changed.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure decision over a resolved identity row. Owner ⇒ Scene stays reachable. */
export function sceneAllowedForIdentity(row: OwnerIdentityRow | null | undefined): boolean {
  return isOwnerIdentity(row);
}

/**
 * The ONE rule the renderer applies, as a pure function: a request that resolves
 * to Scene (including an OMITTED mode, which renders as Scene) is parked unless
 * the caller is the owner. A Faceless request is never refused by this gate.
 */
export function sceneParkedForRequest(mode: string | null | undefined, allowed: boolean): boolean {
  const resolved = mode === 'faceless' ? 'faceless' : 'scene';
  return resolved === 'scene' && !allowed;
}

/** The body a refused caller receives (controllers return it with 403). */
export function sceneRefusalBody() {
  return { status: 'error' as const, error: SCENE_PARKED_MESSAGE, code: SCENE_PARKED_CODE };
}

/**
 * May this user still render a Scene-Based video? Fails CLOSED: an empty,
 * sentinel, non-uuid or unreadable identity is never the owner, so it is
 * refused. A DB failure must never open the door.
 */
export async function isSceneAllowedForUser(userId: string | null | undefined): Promise<boolean> {
  const id = String(userId ?? '').trim();
  if (!UUID_RE.test(id)) return false;
  // The seeded owner UUID identifies the owner on its own (isOwnerIdentity
  // returns true for it without any row), so Scene stays open to her even if the
  // identity read below cannot complete.
  if (id.toLowerCase() === OWNER_USER_ID) return true;
  try {
    const [row] = await db
      .select({ id: schema.users.id, email: schema.users.email, tier: schema.users.tier })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    return sceneAllowedForIdentity(row);
  } catch {
    return false;
  }
}

/**
 * Thrown by the Scene renderer when a non-owner asks for a Scene-Based video.
 * Typed so every entry point can answer 403 + SCENE_PARKED_MESSAGE instead of a
 * 500.
 */
export class SceneUnavailableError extends Error {
  readonly code = SCENE_PARKED_CODE;
  constructor(message: string = SCENE_PARKED_MESSAGE) {
    super(message);
    this.name = 'SceneUnavailableError';
  }
}

/** True when an unknown error is the parked-Scene refusal. */
export function isSceneUnavailableError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as any).code === SCENE_PARKED_CODE;
}
