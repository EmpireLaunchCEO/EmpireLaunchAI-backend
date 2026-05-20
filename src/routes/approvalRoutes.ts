import { Router } from 'express';
import { getPendingApprovals, respondToApproval } from '../controllers/approvalController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.get('/pending', mobileAuth, getPendingApprovals);
router.post('/respond', mobileAuth, respondToApproval);

export default router;
