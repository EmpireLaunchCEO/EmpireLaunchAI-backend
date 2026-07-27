import { Router } from 'express';
import { getPendingApprovals, respondToApproval, createApproval, clearApprovals, saveToLibrary } from '../controllers/approvalController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.get('/pending', mobileAuth, getPendingApprovals);
router.post('/respond', mobileAuth, respondToApproval);
router.post('/create', mobileAuth, createApproval);
router.delete('/clear', mobileAuth, clearApprovals);
router.post('/save-to-library', mobileAuth, saveToLibrary);

export default router;
