/**
 * ONE limiter and ONE daily counter for Etsy — module-level, shared by every
 * Etsy caller in this codebase (harvester, etsyService, the Intel calls and the
 * universal gateway). A second copy of either is a defect.
 *
 * The owner's quota, given by her on 23 Nov: **5 requests per second and 5,000
 * requests per day.** Those two numbers live here as constants and nowhere else.
 */

/** Etsy allows 5 requests per second. */
export const ETSY_QPS_LIMIT = 5;

/** 200ms between requests. Never hardcode 200 elsewhere — derive it from the QPS. */
export const ETSY_MIN_INTERVAL_MS = 1000 / ETSY_QPS_LIMIT;

/** Etsy allows 5,000 requests per UTC day. */
export const ETSY_DAILY_LIMIT = 5000;

/** Warn the operators at 80% of the day's quota. */
export const ETSY_WARNING_PERCENT = 80;

/** A 429 backoff is capped so a bad header value cannot park Etsy for hours. */
const MAX_BACKOFF_MS = 60_000;
/** Backoff used when a 429 arrives with no usable Retry-After. */
const DEFAULT_BACKOFF_MS = 1_000;

export type EtsyRateLimitStatus = 'ok' | 'warning' | 'blocked';

let lastRequestAt = 0;
let dailyCount = 0;
let dailyKey = utcDayKey(new Date());
let blockedUntil = 0;

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

/** Roll the daily counter over when the UTC day changes. */
function rollDayIfNeeded(now: number = Date.now()): void {
  const key = utcDayKey(new Date(now));
  if (key !== dailyKey) {
    if (dailyCount > 0) {
      console.log(`[EtsyRateLimit] New UTC day — resetting the counter from ${dailyCount} calls`);
    }
    dailyKey = key;
    dailyCount = 0;
  }
}

export class EtsyDailyLimitReachedError extends Error {
  readonly code = 'ETSY_DAILY_LIMIT';
  constructor(count: number, limit: number = ETSY_DAILY_LIMIT) {
    super(
      `Etsy daily limit reached (${count}/${limit} calls today) — no Etsy requests until the UTC day rolls over`,
    );
    this.name = 'EtsyDailyLimitReachedError';
  }
}

/** Current daily usage. Read by enforcement and by every UI string, so they agree. */
export function getEtsyDailyUsage(now: number = Date.now()): {
  count: number;
  limit: number;
  remaining: number;
  percent: number;
  day: string;
} {
  rollDayIfNeeded(now);
  return {
    count: dailyCount,
    limit: ETSY_DAILY_LIMIT,
    remaining: Math.max(0, ETSY_DAILY_LIMIT - dailyCount),
    percent: Math.round((dailyCount / ETSY_DAILY_LIMIT) * 100),
    day: dailyKey,
  };
}

/** True once the day's quota is spent — callers must stop, not queue. */
export function isEtsyDailyLimitReached(now: number = Date.now()): boolean {
  rollDayIfNeeded(now);
  return dailyCount >= ETSY_DAILY_LIMIT;
}

export function getEtsyRateLimitStatus(now: number = Date.now()): EtsyRateLimitStatus {
  rollDayIfNeeded(now);
  if (dailyCount >= ETSY_DAILY_LIMIT) return 'blocked';
  if (dailyCount >= (ETSY_DAILY_LIMIT * ETSY_WARNING_PERCENT) / 100) return 'warning';
  return 'ok';
}

/** Record one outbound call against the day's quota. */
export function recordEtsyCall(now: number = Date.now()): void {
  rollDayIfNeeded(now);
  dailyCount += 1;
}

/** Parse a Retry-After value (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: unknown, now: number = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value * 1000);
  if (typeof value === 'string' && value.trim().length > 0) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  return DEFAULT_BACKOFF_MS;
}

/**
 * Etsy answered 429 (or an explicit rate-limit error). Park every Etsy request
 * until the backoff elapses, honouring Retry-After when Etsy sent one.
 * Never tight-retries: the wait is what stops the hammering.
 */
export function noteEtsyRateLimit(retryAfter?: unknown): number {
  const wait = Math.min(MAX_BACKOFF_MS, parseRetryAfterMs(retryAfter));
  blockedUntil = Math.max(blockedUntil, Date.now() + wait);
  console.warn(`[EtsyRateLimit] Etsy rate-limited us — backing off ${wait}ms before the next call`);
  return wait;
}

/**
 * Await a slot: first the 429 backoff (if any), then the 200ms spacing that keeps
 * us at or below 5 requests a second. Throws when the day's quota is spent.
 */
export async function awaitEtsySlot(): Promise<void> {
  if (isEtsyDailyLimitReached()) throw new EtsyDailyLimitReachedError(dailyCount);

  const waitUntil = Math.max(blockedUntil, lastRequestAt + ETSY_MIN_INTERVAL_MS);
  const delay = waitUntil - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  lastRequestAt = Date.now();
}

function isRateLimitError(err: any): boolean {
  const status = err?.response?.status ?? err?.status;
  if (status === 429) return true;
  if (err?.code === 'ETSY_RATE_LIMITED') return true;
  const body = err?.response?.data;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return /rate[\s_-]?limit/i.test(text);
}

/**
 * THE way to make an Etsy request: take a slot, record the call, run it, and back
 * off if Etsy says 429. Every call site in this codebase goes through this.
 */
export async function runEtsyRequest<T>(fn: () => Promise<T>): Promise<T> {
  await awaitEtsySlot();
  recordEtsyCall();
  try {
    return await fn();
  } catch (err: any) {
    if (isRateLimitError(err)) {
      const retryAfter = err?.response?.headers?.['retry-after'] ?? err?.headers?.['retry-after'];
      noteEtsyRateLimit(retryAfter);
    }
    throw err;
  }
}

/** Test hook: clear the module-level limiter state between tests. */
export function resetEtsyRateLimitState(): void {
  lastRequestAt = 0;
  dailyCount = 0;
  dailyKey = utcDayKey(new Date());
  blockedUntil = 0;
}
