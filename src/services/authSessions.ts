/**
 * REAL SESSIONS (owner, Nov 27: "fix authentication first").
 *
 * Before this module, identity was whatever a request claimed:
 *   - `mobileAuth` auto-provisioned a user row for any anonymous caller and
 *     minted them a session, so `x-user-id: <any id>` was a login;
 *   - `POST /api/auth/login` returned only `{ userId }` — no token at all, so the
 *     frontend invented a UUID and sent it as `Authorization: Bearer <uuid>`.
 *
 * A session is now a row in `auth_sessions`:
 *   - the raw token is generated here, returned to the caller ONCE, and never
 *     stored — only its SHA-256 hex digest is (`tokenHash`);
 *   - it expires 30 days after creation;
 *   - `lastUsedAt` is touched whenever it authenticates a request;
 *   - logging out deletes the row, so a copied token stops working immediately.
 *
 * Nothing in this file creates a user. A request can never turn itself into an
 * account.
 */
import { db, schema } from '../db/index.js';
import { and, eq, gt } from 'drizzle-orm';
import crypto from 'crypto';
import type { Request } from 'express';

const { authSessions, users } = schema;

/** 30 days, one constant — the only place a session lifetime is decided. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What a caller gets back from login / register / master-login. */
export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

export interface AuthenticatedCaller {
  userId: string;
  user: any;
  sessionId: string;
}

/** SHA-256 hex of a raw token. The only form of a token that is ever stored. */
export function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
}

/** A fresh, unguessable session token (32 random bytes, url-safe). */
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Create a session row for an existing user and return the raw token once.
 * `userAgent` is optional and purely informational.
 */
export async function createSession(userId: string, userAgent?: string | null): Promise<IssuedSession> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(authSessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    createdAt: new Date(),
    lastUsedAt: null,
    userAgent: userAgent ? String(userAgent).slice(0, 400) : null,
  });

  return { token, expiresAt };
}

/**
 * Resolve a raw token to its owner. Returns null for an unknown token, an
 * expired token, or a token that is not a session at all (a user id, a random
 * uuid, an empty string) — every one of those is simply "not signed in".
 */
export async function findSession(rawToken: string | null | undefined): Promise<AuthenticatedCaller | null> {
  if (typeof rawToken !== 'string') return null;
  const token = rawToken.trim();
  if (!token) return null;

  const [session] = await db.select()
    .from(authSessions)
    .where(and(
      eq(authSessions.tokenHash, hashSessionToken(token)),
      gt(authSessions.expiresAt, new Date()),
    ))
    .limit(1);

  if (!session) return null;

  const [user] = await db.select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  // A session whose user row is gone is not a session.
  if (!user) return null;

  // Best-effort freshness marker; never fail a request over it.
  try {
    await db.update(authSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(authSessions.id, session.id));
  } catch {}

  return { userId: user.id, user, sessionId: session.id };
}

/** Revoke one session (logout). Returns true when a row was deleted. */
export async function revokeSession(rawToken: string | null | undefined): Promise<boolean> {
  if (typeof rawToken !== 'string' || !rawToken.trim()) return false;
  const hash = hashSessionToken(rawToken.trim());
  const [existing] = await db.select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.tokenHash, hash))
    .limit(1);
  if (!existing) return false;
  await db.delete(authSessions).where(eq(authSessions.tokenHash, hash));
  return true;
}

/** Revoke every session of a user (used when a password changes). */
export async function revokeAllSessions(userId: string): Promise<void> {
  if (!userId) return;
  await db.delete(authSessions).where(eq(authSessions.userId, userId));
}

/**
 * The one way to read a token off a request.
 *
 * `Authorization: Bearer <token>` is the normal door. The query form exists for
 * exactly one case: a browser `<video src>` cannot set a header, so the finished-
 * video stream link carries the token in `?token=`. It is NOT a general second
 * door for JSON APIs, and it is stripped from the access log (see index.ts).
 */
export function sessionTokenFromRequest(req: Request): string | null {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return token;
  }
  const query = (req.query as any)?.token;
  if (typeof query === 'string' && query.trim()) return query.trim();
  return null;
}

/** Resolve the caller of a request, or null. Used by requireOwner / tenantIsolation. */
export async function callerForRequest(req: Request): Promise<AuthenticatedCaller | null> {
  return findSession(sessionTokenFromRequest(req));
}
