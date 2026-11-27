/**
 * Sales-rep tracking endpoints (spec: REP-TRACKING-SPEC.md).
 *
 * Identity is always `req.userId` / `req.user` from a real session — never an
 * id in the request. A rep sees only their own numbers; the owner sees every
 * rep and is the only one who can create codes, set roles, or clear what she
 * has paid.
 */
import { Request, Response } from 'express';
import { isOwnerIdentity } from '../services/ownerIdentity.js';
import {
  assignUserRole,
  createReferralCode,
  DEMO_SAMPLE_CONTENT,
  listReps,
  markCommissionPaid,
  repStats,
  referralLink,
} from '../services/repTracking.js';

/**
 * GET /api/rep/me — the caller's own code, link, signups, paying clients,
 * owed and paid cents. A `client` account gets a bare 403.
 */
export const getMyRepStats = async (req: Request, res: Response) => {
  try {
    const caller = (req as any).user;
    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ error: 'AUTH_REQUIRED' });

    const role = String(caller?.role ?? '').toLowerCase();
    if (role !== 'sales_rep' && !isOwnerIdentity(caller)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const stats = await repStats(userId);
    return res.json({ status: 'success', ...stats });
  } catch (error: any) {
    console.error('[rep] /me failed:', error?.message || error);
    return res.status(500).json({ error: 'Could not read rep stats' });
  }
};

/** GET /api/rep/summary — owner only: every rep, plus totals. */
export const getRepSummary = async (req: Request, res: Response) => {
  try {
    const reps = await listReps();
    const rows = [];
    const totals = { reps: 0, signups: 0, payingClients: 0, owedCents: 0, paidCents: 0 };

    for (const rep of reps) {
      const stats = await repStats(rep.id);
      rows.push({ ...stats, name: rep.name ?? null, email: rep.email ?? null });
      totals.reps += 1;
      totals.signups += stats.signups;
      totals.payingClients += stats.payingClients;
      totals.owedCents += stats.owedCents;
      totals.paidCents += stats.paidCents;
    }

    return res.json({ status: 'success', reps: rows, totals });
  } catch (error: any) {
    console.error('[rep] /summary failed:', error?.message || error);
    return res.status(500).json({ error: 'Could not read rep summary' });
  }
};

/**
 * POST /api/rep/mark-paid — owner only. `{ repUserId, period }` clears one
 * month; `{ repUserId, upToPeriod }` clears every unpaid month up to it.
 * No money moves: this only records that she has sent it.
 */
export const markPaid = async (req: Request, res: Response) => {
  try {
    const { repUserId, period, upToPeriod } = req.body || {};
    if (!repUserId || (!period && !upToPeriod)) {
      return res.status(400).json({ error: 'repUserId and period (or upToPeriod) are required' });
    }

    const result = await markCommissionPaid({ repUserId, period, upToPeriod });
    return res.json({ status: 'success', ...result });
  } catch (error: any) {
    const message = error?.message || 'Could not mark commission paid';
    const status = message === 'no such user' ? 404 : 400;
    console.error('[rep] /mark-paid failed:', message);
    return res.status(status).json({ error: message });
  }
};

/** POST /api/rep/codes — owner only: a link for an existing account. */
export const createCode = async (req: Request, res: Response) => {
  try {
    const { repUserId, code } = req.body || {};
    if (!repUserId) return res.status(400).json({ error: 'repUserId is required' });

    const row = await createReferralCode({ repUserId, code });
    return res.json({
      status: 'success',
      repUserId: row.repUserId,
      code: row.code,
      link: referralLink(row.code),
    });
  } catch (error: any) {
    const message = error?.message || 'Could not create referral code';
    const status = message === 'no such user' ? 404 : 400;
    console.error('[rep] /codes failed:', message);
    return res.status(status).json({ error: message });
  }
};

/**
 * POST /api/rep/assign-role — owner only: 'sales_rep' | 'demo' | 'client'.
 *
 * The account may be named by `userId` or by `email` — the owner turns an
 * existing sign-up into a rep by typing the address she already has. A rep
 * always comes back with a working code: an existing one, or a new one derived
 * from her own name.
 */
export const assignRole = async (req: Request, res: Response) => {
  try {
    const { userId, email, role } = req.body || {};
    if ((!userId && !email) || !role) {
      return res.status(400).json({ error: 'userId or email, and role, are required' });
    }

    const updated = await assignUserRole({ userId, email, role });
    if (!updated) return res.status(404).json({ error: 'no such user' });

    // Only a rep hands out a link; promoting to client/demo creates nothing.
    let code: string | null = null;
    if (updated.role === 'sales_rep') {
      const row = await createReferralCode({ repUserId: updated.id });
      code = row?.code ?? null;
    }

    return res.json({
      status: 'success',
      userId: updated.id,
      email: updated.email ?? null,
      role: updated.role,
      code,
      link: referralLink(code),
    });
  } catch (error: any) {
    console.error('[rep] /assign-role failed:', error?.message || error);
    return res.status(400).json({ error: error?.message || 'Could not assign role' });
  }
};

/**
 * GET /api/rep/demo-sample — the fixed sample dataset a demo account renders.
 * Read-only and never generated on request, so a demo can never spend a render.
 */
export const getDemoSample = async (_req: Request, res: Response) => {
  return res.json({ status: 'success', sample: DEMO_SAMPLE_CONTENT });
};
