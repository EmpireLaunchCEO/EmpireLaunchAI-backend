import { Router } from 'express';
import { requireOwner } from '../middleware/requireOwner.js';
import { getClientStats } from '../controllers/adminController.js';

const router = Router();

// Owner-only business numbers rendered on Home Base ("Active Subscribers").
// requireOwner is the only gate: no identity / non-owner => 403 with no counts.
router.get('/client-stats', requireOwner, getClientStats);

export default router;
