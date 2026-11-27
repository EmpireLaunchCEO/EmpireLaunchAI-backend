import { Router } from 'express';
import {
  assignRole,
  createCode,
  getDemoSample,
  getMyRepStats,
  getRepSummary,
  markPaid,
} from '../controllers/repController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { requireOwner } from '../middleware/requireOwner.js';

/**
 * /api/rep — sales-rep tracking.
 *
 * `mobileAuth` resolves the caller from a real session; `requireOwner` is the
 * only gate on the owner's views. No endpoint takes an identity from the body.
 */
const router = Router();

router.get('/me', mobileAuth, getMyRepStats);
router.get('/summary', requireOwner, getRepSummary);
router.post('/mark-paid', requireOwner, markPaid);
router.post('/codes', requireOwner, createCode);
router.post('/assign-role', requireOwner, assignRole);
// The fixed demo dataset — read-only, never generated on request.
router.get('/demo-sample', mobileAuth, getDemoSample);

export default router;
