/**
 * memoryService.ts — Durable AI Memory for the Studio AI Router.
 *
 * Persists "locked"/confirmed decisions (voice, tone, duration, platform,
 * brand niche, approved design directions, answered clarifying questions) per
 * user (+ optional brand) in the `session_memory` table. When the router runs,
 * studioRoutes loads these facts and injects them as a "settled decisions —
 * do not re-ask" context block alongside the live conversation history, so the
 * AI does NOT re-ask questions already answered in a previous session.
 *
 * Scopes to the resolveUserId pattern: a real UUID userId is required before any
 * persistence. Sentinel values ('system', 'anonymous', '') are never written.
 */

import { eq, and, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export interface LockedFacts {
  voice?: string;
  tone?: string;
  duration?: number;
  platform?: string;
  aspectRatio?: string;
  brandNiche?: string;
  brandColors?: string[];
  answeredQuestions?: string[];
  approvedDirections?: string[];
  [key: string]: any;
}

interface MemoryRow {
  id: string;
  lockedFacts: LockedFacts;
  lastSummary?: string | null;
}

/** Core fact keys the router treats as "settled" and stops re-asking. */
const FACT_KEYS = ['voice', 'tone', 'duration', 'platform', 'aspectRatio', 'brandNiche', 'brandColors'] as const;

function isValidUser(userId?: string | null): boolean {
  if (!userId) return false;
  return !/^(system|anonymous)$/i.test(String(userId).trim());
}

/**
 * Load locked facts for a user (+ optional brand). Returns {} when absent.
 * Never throws — a DB hiccup degrades to empty memory (fresh-session behavior),
 * which only means the AI may ask again; it must not break generation.
 */
export async function loadLockedFacts(userId?: string | null, brandId?: string | null): Promise<LockedFacts> {
  if (!isValidUser(userId)) return {};
  try {
    const rows = await db.select().from(schema.sessionMemory)
      .where(and(eq(schema.sessionMemory.userId, userId), eq(schema.sessionMemory.brandId, brandId ?? null)))
      .limit(1);
    const row: MemoryRow | undefined = rows?.[0];
    if (!row?.lockedFacts) return {};
    return typeof row.lockedFacts === 'string' ? safeParse(row.lockedFacts) : row.lockedFacts;
  } catch (err) {
    console.warn('[Memory] loadLockedFacts failed:', (err as Error)?.message);
    return {};
  }
}

/**
 * Merge new locked facts into stored memory (per user + brand), preserving
 * already-locked values unless the new value is explicitly different.
 * Falls back to per-user row when brandId is not given. Never throws.
 */
export async function saveLockedFacts(
  userId?: string | null,
  brandId?: string | null,
  newFacts: LockedFacts = {},
): Promise<void> {
  if (!isValidUser(userId)) return;
  try {
    const existing = await loadLockedFacts(userId, brandId);
    const merged: LockedFacts = { ...existing };
    for (const key of Object.keys(newFacts)) {
      const val = (newFacts as any)[key];
      if (val === undefined || val === null || val === '') continue;
      if (Array.isArray(val)) {
        const cur = Array.isArray(merged[key]) ? merged[key] : [];
        merged[key] = Array.from(new Set([...cur, ...val]));
      } else {
        merged[key] = val;
      }
    }
    await upsertMemoryRow(userId!, brandId, merged);
  } catch (err) {
    console.warn('[Memory] saveLockedFacts failed:', (err as Error)?.message);
  }
}

/** Upsert one memory row keyed by (user_id, brand_id). */
async function upsertMemoryRow(userId: string, brandId: string | null, facts: LockedFacts): Promise<void> {
  const existing = await db.select().from(schema.sessionMemory)
    .where(and(eq(schema.sessionMemory.userId, userId), eq(schema.sessionMemory.brandId, brandId)))
    .limit(1);
  if (existing?.[0]) {
    await db.update(schema.sessionMemory)
      .set({ lockedFacts: facts, updatedAt: sql`now()` })
      .where(eq(schema.sessionMemory.id, existing[0].id));
  } else {
    await db.insert(schema.sessionMemory).values({
      userId,
      brandId,
      lockedFacts: facts,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

/**
 * Build the "settled decisions / do not re-ask" prompt block injected into the
 * router's system prompt. Only includes non-empty fact keys.
 */
export function buildMemoryContext(facts: LockedFacts): string {
  const lines: string[] = [];
  for (const key of FACT_KEYS) {
    const val = facts[key];
    if (val === undefined || val === null || val === '') continue;
    if (Array.isArray(val) && val.length === 0) continue;
    const label = key.replace(/([A-Z])/g, ' $1').toLowerCase();
    lines.push(`- ${label}: ${Array.isArray(val) ? val.join(', ') : String(val)}`);
  }
  const answered = facts.answeredQuestions?.length ? `\n- already answered questions: ${facts.answeredQuestions.join('; ')}` : '';
  if (lines.length === 0 && !answered) return '';
  return (
    `\nSETTLED DECISIONS (do not re-ask, treat as confirmed):\n${lines.join('\n')}${answered}\n` +
    `Treat these as already locked by the user. DO NOT ask about them again. ` +
    `Only ask genuinely NEW clarifying questions when needed info is still missing.`
  );
}

function safeParse(raw: string): LockedFacts {
  try {
    return JSON.parse(raw) as LockedFacts;
  } catch {
    return {};
  }
}
