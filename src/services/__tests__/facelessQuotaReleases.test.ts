/**
 * A FACELESS ROW IS NOT A FACELESS VIDEO (owner, Nov 23):
 * "IF a video fails for a client, their video count doesn't get reduced, especially
 * if it doesn't run."
 *
 * `createApproval` writes the submission receipt BEFORE the paid work starts, so the
 * old count (every `approvals` row of type 'faceless' in the window) spent the 15/week
 * allowance on renders that failed, were refused, or never ran. `getDailyRemaining`
 * now counts a row only when `payload.status === 'completed'` or when it is
 * `'processing'` and inside FACELESS_IN_FLIGHT_WINDOW_MS.
 *
 * These tests drive the REAL `usageService.getDailyRemaining` / `enforceLimit` through
 * the real classification, with only the database layer swapped for an in-memory
 * store (same approach as facelessWorkerReal.test.ts). No paid calls, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, schema } from '../../db/index.js';
import {
  usageService,
  WEEKLY_FACELESS_LIMIT,
  FACELESS_IN_FLIGHT_WINDOW_MS,
} from '../usageService.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MIN = 60 * 1000;

type Row = Record<string, any>;

/** Only the three tables this path touches: users (owner check + window start) and
 *  approvals (the faceless rows). Any other table yields nothing. */
function installDb(approvalRows: Row[], user: Row = {
  id: USER_ID,
  email: 'client@example.com',
  tier: 'STARTER',
  createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
}) {
  const anyDb = db as any;
  const orig = { select: anyDb.select };
  anyDb.select = () => {
    let table: any;
    const self: any = {
      from(t: any) { table = t; return self; },
      where() { return self; },
      orderBy() { return self; },
      limit() { return self; },
      then(res: any, rej: any) {
        const rows = table === schema.users ? [user] : table === schema.approvals ? approvalRows : [];
        return Promise.resolve(rows.map((r) => ({ ...r }))).then(res, rej);
      },
    };
    return self;
  };
  return () => { Object.assign(anyDb, orig); };
}

const row = (payload: any, ageMs: number, status = 'approved'): Row => ({
  id: `row-${Math.random().toString(36).slice(2)}`,
  userId: USER_ID,
  type: 'faceless',
  payload,
  status,
  createdAt: new Date(Date.now() - ageMs),
});

test('the in-flight window is past the pipeline\'s own 12-minute span budget', () => {
  assert.ok(FACELESS_IN_FLIGHT_WINDOW_MS > 12 * MIN, 'a live render must never look dead');
  assert.equal(FACELESS_IN_FLIGHT_WINDOW_MS, 30 * MIN);
});

test('a failed render returns the quota (failed / refused / never-started rows cost nothing)', async () => {
  const restore = installDb([
    row({ status: 'completed', projectId: 'p-done' }, 2 * MIN),          // delivered → 1
    row({ status: 'failed', projectId: 'p-1', error: 'Assembly: x' }, 5 * MIN, 'failed'),
    row({ status: 'failed', projectId: 'p-2' }, 6 * MIN, 'failed'),
    row({ status: 'refused', projectId: 'p-3' }, 7 * MIN, 'failed'),
    row({ projectId: 'p-4' }, 8 * MIN),                                   // legacy, no status
  ]);
  try {
    assert.equal(await usageService.getDailyRemaining(USER_ID, 'faceless'), WEEKLY_FACELESS_LIMIT - 1);
  } finally { restore(); }
});

test('a completed render keeps its slot', async () => {
  const restore = installDb([
    row({ status: 'completed', projectId: 'a' }, 1 * MIN),
    row({ status: 'completed', projectId: 'b' }, 2 * MIN),
    row({ status: 'completed', projectId: 'c' }, 3 * MIN),
    row({ status: 'failed', projectId: 'd' }, 4 * MIN, 'failed'),
  ]);
  try {
    assert.equal(await usageService.getDailyRemaining(USER_ID, 'faceless'), WEEKLY_FACELESS_LIMIT - 3);
  } finally { restore(); }
});

test('an in-flight launch still blocks a second one', async () => {
  // A launch that started 4 minutes ago is genuinely rendering: it holds its slot.
  const restore = installDb([row({ status: 'processing', projectId: 'live' }, 4 * MIN)]);
  try {
    assert.equal(await usageService.getDailyRemaining(USER_ID, 'faceless'), WEEKLY_FACELESS_LIMIT - 1);
  } finally { restore(); }

  // The whole allowance rendering at once → the next launch is refused, not admitted.
  const full = installDb(Array.from({ length: WEEKLY_FACELESS_LIMIT }, (_v, i) =>
    row({ status: 'processing', projectId: `live-${i}` }, (i + 1) * MIN)));
  try {
    assert.equal(await usageService.getDailyRemaining(USER_ID, 'faceless'), 0);
    await assert.rejects(() => usageService.enforceLimit(USER_ID, 'faceless'), /Usage limit reached/);
  } finally { full(); }
});

test('a dead processing row past the window releases the quota by itself', async () => {
  const restore = installDb([
    row({ status: 'processing', projectId: 'crashed' }, 31 * MIN),
    row({ status: 'completed', projectId: 'done' }, 60 * MIN),
  ]);
  try {
    assert.equal(await usageService.getDailyRemaining(USER_ID, 'faceless'), WEEKLY_FACELESS_LIMIT - 1);
  } finally { restore(); }
});
