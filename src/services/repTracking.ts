/**
 * SALES-REP TRACKING (owner decisions, Nov 27).
 *
 * The owner's words, and what this module does about each of them:
 *   - "a rep is paid $1 per client, per month, for as long as that client is a
 *     paying customer" → `commission_events`, one row per (rep, client, period),
 *     written when a payment is recorded. No payment, no row.
 *   - "the owner sends the money herself" → `markCommissionPaid` only stamps
 *     `paid_out_at`. There is no transfer, no payout API, nothing that moves
 *     money. This module tells her what she owes.
 *   - "a rep gets their own link" → `referral_codes` (one per rep) and the
 *     `/join/<code>` link built here.
 *   - a demo account "uses sample data only — never a real video render" →
 *     `role = 'demo'`, refused at the render doors (middleware/demoRefusal.ts).
 *
 * Attribution happens at SIGNUP, not at payment: a client who signs up through
 * `/join/<code>` and pays two months later is still that rep's client.
 *
 * Everything here is idempotent by construction. The unique key
 * (rep_user_id, client_user_id, period) is the guarantee that a replayed Stripe
 * webhook cannot pay a rep twice; a client's referral row is written once and
 * never duplicated.
 */
import { db, schema } from '../db/index.js';
import { and, eq, isNull, lte, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const { users, referrals, referralCodes, commissionEvents } = schema;

/** $1 per client, per month. One constant — the owner's number, in one place. */
export const COMMISSION_CENTS_PER_CLIENT_MONTH = 100;

/** What an account may see and do. Never the same thing as `tier`. */
export const USER_ROLES = ['client', 'sales_rep', 'demo'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** The roles an owner may assign through POST /api/rep/assign-role. */
export const ASSIGNABLE_ROLES: readonly UserRole[] = ['client', 'sales_rep', 'demo'];

/**
 * Where a rep's link points. The frontend serves `/join/<code>`; this is only
 * the string the rep is given, so it must be the public app address.
 */
export const REFERRAL_LINK_BASE = (
  process.env.PUBLIC_APP_URL ||
  process.env.APP_BASE_URL ||
  'https://www.empirelaunchai.com'
).replace(/\/+$/, '');

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** True for a demo account — the only role refused at the render doors. */
export function isDemoUser(user: { role?: unknown } | null | undefined): boolean {
  return String((user as any)?.role ?? '').toLowerCase() === 'demo';
}

/**
 * One canonical form for a code: uppercase letters and digits only, max 16.
 * `marc y`, `MARCy`, ` /join/MARCY ` all become `MARCY`, so a typed code and a
 * pasted link cannot disagree.
 */
export function normalizeReferralCode(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);
}

/**
 * A code derived from the rep's own name: the first word, letters only, padded
 * to at least three characters, falling back to `REP` for a nameless account.
 */
export function deriveCodeFromName(name: unknown): string {
  const first = String(name ?? '')
    .trim()
    .split(/\s+/)[0]
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);
  if (first.length >= 3) return first;
  if (first.length > 0) return (first + 'REP').slice(0, 3);
  return 'REP';
}

/** The commission period for a payment: the UTC calendar month, `YYYY-MM`. */
export function commissionPeriod(paidAt: Date | string | number): string {
  const date = paidAt instanceof Date ? paidAt : new Date(paidAt);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** The link a rep hands out. */
export function referralLink(code: string | null | undefined): string | null {
  const clean = normalizeReferralCode(code);
  return clean ? `${REFERRAL_LINK_BASE}/join/${clean}` : null;
}

/** An active code, or null. An inactive code attributes nothing. */
export async function findActiveReferralCode(rawCode: unknown): Promise<any | null> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;
  const rows = await db.select().from(referralCodes)
    .where(and(eq(referralCodes.code, code), eq(referralCodes.active, true)))
    .limit(1);
  return rows?.[0] ?? null;
}

/**
 * Create (or return) a rep's code. The owner may name it; otherwise it is
 * derived from the rep's name. A collision is resolved by appending a digit
 * rather than by failing — two reps called Marc both get a working link.
 */
export async function createReferralCode(input: { repUserId: string; code?: string | null }): Promise<any> {
  const repUserId = String(input.repUserId || '').trim();
  if (!repUserId) throw new Error('repUserId is required');

  const [rep] = await db.select().from(users).where(eq(users.id, repUserId)).limit(1);
  if (!rep) throw new Error('no such user');

  const existingForRep = await db.select().from(referralCodes)
    .where(eq(referralCodes.repUserId, repUserId)).limit(1);
  if (existingForRep?.[0]) return existingForRep[0];

  const requested = normalizeReferralCode(input.code);
  const base = requested || deriveCodeFromName((rep as any).name || (rep as any).email);

  let code = base;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const taken = await db.select().from(referralCodes).where(eq(referralCodes.code, code)).limit(1);
    if (!taken?.[0]) break;
    code = `${base}${attempt + 2}`.slice(0, 16);
  }

  const row = {
    id: uuidv4(),
    code,
    repUserId,
    active: true,
    createdAt: new Date(),
  };
  await db.insert(referralCodes).values(row);
  return row;
}

/** The single attribution row for a client, if one exists. Written once. */
async function existingAttribution(clientUserId: string): Promise<any | null> {
  const rows = await db.select().from(referrals)
    .where(eq(referrals.clientUserId, clientUserId))
    .limit(1);
  return rows?.[0] ?? null;
}

/**
 * Attribute a client to the rep whose code they signed up with.
 *
 * Once per client: a client who registers twice, or whose signup is retried,
 * keeps the first attribution. Returns the row (existing or new), or null when
 * the code is unknown/inactive.
 */
export async function attributeSignupReferral(input: {
  clientUserId: string;
  code: unknown;
}): Promise<any | null> {
  const clientUserId = String(input.clientUserId || '').trim();
  if (!clientUserId) return null;

  const active = await findActiveReferralCode(input.code);
  if (!active) return null;

  const existing = await existingAttribution(clientUserId);
  if (existing) return existing;

  const [rep] = await db.select().from(users).where(eq(users.id, active.repUserId)).limit(1);
  const row = {
    id: uuidv4(),
    clientUserId,
    salespersonName: String((rep as any)?.name || (rep as any)?.email || active.code),
    repUserId: active.repUserId,
    source: 'signup',
    createdAt: new Date(),
  };
  await db.insert(referrals).values(row);
  return row;
}

/**
 * Attribute a client from a payment that carries `metadata.referral` (the
 * path that existed before reps had accounts). The value may be a code or the
 * salesperson's first name; a name is kept as the salesperson name even when no
 * rep account matches, so old links keep working.
 */
export async function attributePaymentReferral(input: {
  clientUserId: string;
  referral: unknown;
}): Promise<any | null> {
  const clientUserId = String(input.clientUserId || '').trim();
  const raw = String(input.referral ?? '').trim();
  if (!clientUserId || !raw) return null;

  const existing = await existingAttribution(clientUserId);
  if (existing) return existing;

  const active = await findActiveReferralCode(raw);
  let repUserId: string | null = active?.repUserId ?? null;
  let salespersonName: string = raw;

  if (active) {
    const [rep] = await db.select().from(users).where(eq(users.id, active.repUserId)).limit(1);
    salespersonName = String((rep as any)?.name || (rep as any)?.email || active.code);
  } else {
    // Legacy name attribution: match a rep account by name when one exists, so
    // a payment through an old link still accrues to the right person.
    const rep = await findRepByName(raw);
    if (rep) {
      repUserId = (rep as any).id;
      salespersonName = String((rep as any).name || raw);
    }
  }

  const row = {
    id: uuidv4(),
    clientUserId,
    salespersonName,
    repUserId,
    source: 'payment',
    createdAt: new Date(),
  };
  await db.insert(referrals).values(row);
  return row;
}

/** A rep account whose name matches, case-insensitively. */
async function findRepByName(name: string): Promise<any | null> {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const rows = await db.select().from(users).where(eq(users.role, 'sales_rep'));
  const match = (rows || []).find((row: any) => String(row?.name || '').trim().toLowerCase() === wanted);
  return match ?? null;
}

/**
 * Accrue one month of commission for a client who just paid.
 *
 * Called from the two places a payment is recorded (`verifyPlatformPayment` and
 * the Stripe webhook store). A client with no attribution accrues nothing; a
 * replayed payment for a month already accrued inserts nothing, because the
 * unique (rep, client, period) key conflicts. Returns the new row, or null when
 * nothing was owed.
 */
export async function accrueCommissionForPayment(input: {
  clientUserId: string;
  paidAt?: Date | string | number;
  sourceSubscriptionId?: string | null;
}): Promise<any | null> {
  const clientUserId = String(input.clientUserId || '').trim();
  if (!clientUserId) return null;

  const attribution = await existingAttribution(clientUserId);
  const repUserId = (attribution as any)?.repUserId;
  if (!repUserId) return null;

  const period = commissionPeriod(input.paidAt ?? new Date());

  await db.insert(commissionEvents).values({
    id: uuidv4(),
    repUserId,
    clientUserId,
    period,
    amountCents: COMMISSION_CENTS_PER_CLIENT_MONTH,
    sourceSubscriptionId: input.sourceSubscriptionId ?? null,
    createdAt: new Date(),
    paidOutAt: null,
  }).onConflictDoNothing({
    target: [commissionEvents.repUserId, commissionEvents.clientUserId, commissionEvents.period],
  });

  const [row] = await db.select().from(commissionEvents)
    .where(and(
      eq(commissionEvents.repUserId, repUserId),
      eq(commissionEvents.clientUserId, clientUserId),
      eq(commissionEvents.period, period),
    ))
    .limit(1);
  return row ?? null;
}

export interface RepStats {
  repUserId: string;
  code: string | null;
  link: string | null;
  signups: number;
  payingClients: number;
  owedCents: number;
  paidCents: number;
}

/** Everything one rep is shown, and everything the owner sees per rep. */
export async function repStats(repUserId: string): Promise<RepStats> {
  const id = String(repUserId || '').trim();

  const codes = await db.select().from(referralCodes)
    .where(and(eq(referralCodes.repUserId, id), eq(referralCodes.active, true)))
    .limit(1);
  const code = codes?.[0]?.code ?? null;

  const attributionRows = await db.select().from(referrals).where(eq(referrals.repUserId, id));
  const events = await db.select().from(commissionEvents).where(eq(commissionEvents.repUserId, id));

  let owedCents = 0;
  let paidCents = 0;
  const payingClients = new Set<string>();
  for (const event of events || []) {
    const amount = Number((event as any).amountCents ?? 0);
    if ((event as any).paidOutAt) paidCents += amount;
    else owedCents += amount;
    if ((event as any).clientUserId) payingClients.add(String((event as any).clientUserId));
  }

  return {
    repUserId: id,
    code,
    link: referralLink(code),
    signups: (attributionRows || []).length,
    payingClients: payingClients.size,
    owedCents,
    paidCents,
  };
}

/**
 * The owner has sent the money: stamp `paid_out_at` on what she just cleared.
 * `period` clears exactly one month, `upToPeriod` clears every unpaid month up
 * to and including it. Nothing else is touched — no money moves here.
 */
export async function markCommissionPaid(input: {
  repUserId: string;
  period?: string | null;
  upToPeriod?: string | null;
}): Promise<{ updated: number; amountCents: number; periods: string[] }> {
  const repUserId = String(input.repUserId || '').trim();
  if (!repUserId) throw new Error('repUserId is required');

  const period = input.period ? String(input.period).trim() : null;
  const upToPeriod = input.upToPeriod ? String(input.upToPeriod).trim() : null;
  if (!period && !upToPeriod) throw new Error('period or upToPeriod is required');

  const conditions = [eq(commissionEvents.repUserId, repUserId), isNull(commissionEvents.paidOutAt)];
  if (period) conditions.push(eq(commissionEvents.period, period));
  if (upToPeriod) conditions.push(lte(commissionEvents.period, upToPeriod));

  const targets = await db.select().from(commissionEvents).where(and(...conditions));
  const rows = (targets || []) as any[];
  if (rows.length === 0) return { updated: 0, amountCents: 0, periods: [] };

  const ids = rows.map((row) => row.id);
  await db.update(commissionEvents)
    .set({ paidOutAt: new Date() })
    .where(inArray(commissionEvents.id, ids));

  return {
    updated: rows.length,
    amountCents: rows.reduce((sum, row) => sum + Number(row.amountCents ?? 0), 0),
    periods: [...new Set(rows.map((row) => String(row.period)))].sort(),
  };
}

/** Set an account's role. Only 'client' | 'sales_rep' | 'demo' — never `tier`. */
export async function assignUserRole(input: { userId: string; role: unknown }): Promise<any | null> {
  const userId = String(input.userId || '').trim();
  const role = String(input.role || '').trim().toLowerCase();
  if (!userId) throw new Error('userId is required');
  if (!isUserRole(role) || !ASSIGNABLE_ROLES.includes(role)) throw new Error('invalid role');

  const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existing) return null;

  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
  return { ...existing, role };
}

/** Every rep account, for the owner's summary. */
export async function listReps(): Promise<any[]> {
  const rows = await db.select().from(users).where(eq(users.role, 'sales_rep'));
  return (rows || []) as any[];
}

/**
 * The fixed sample dataset a demo account browses. It is read-only and never
 * generated on request, so a demo can never spend a render.
 */
export const DEMO_SAMPLE_CONTENT = Object.freeze({
  finishedVideoUrl:
    'https://sample.empirelaunchai.com/demo/beadwick-bracelets-tiktok.mp4',
  thumbnailUrl:
    'https://sample.empirelaunchai.com/demo/beadwick-bracelets-tiktok.jpg',
  title: 'Beadwick & Co — handmade bracelets (sample)',
  library: [
    { title: 'Beadwick & Co — bracelet close-up (sample)', type: 'faceless', durationSeconds: 15 },
    { title: 'Beadwick & Co — packing order (sample)', type: 'faceless', durationSeconds: 10 },
  ],
  intel: [
    { label: 'Trending searches', value: 'handmade beaded bracelets (sample)' },
    { label: 'Your market', value: 'Etsy jewellery, US (sample)' },
  ],
});

export const repTracking = {
  COMMISSION_CENTS_PER_CLIENT_MONTH,
  USER_ROLES,
  ASSIGNABLE_ROLES,
  normalizeReferralCode,
  deriveCodeFromName,
  commissionPeriod,
  referralLink,
  isDemoUser,
  findActiveReferralCode,
  createReferralCode,
  attributeSignupReferral,
  attributePaymentReferral,
  accrueCommissionForPayment,
  repStats,
  markCommissionPaid,
  assignUserRole,
  listReps,
  DEMO_SAMPLE_CONTENT,
};
