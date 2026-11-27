import { Router } from 'express';
import { getPendingApprovals, respondToApproval, createApproval, clearApprovals, saveToLibrary, submitNeuralFeedback } from '../controllers/approvalController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { denyDemo } from '../middleware/demoRefusal.js';

const router = Router();

router.get('/pending', mobileAuth, getPendingApprovals);
router.post('/respond', mobileAuth, respondToApproval);
// A demo account shows the product with sample data and never renders:
// denied in middleware, before any controller builds a provider client.
router.post('/create', mobileAuth, denyDemo, createApproval);
router.delete('/clear', mobileAuth, clearApprovals);
router.post('/save-to-library', mobileAuth, saveToLibrary);
router.post('/:id/feedback', mobileAuth, submitNeuralFeedback);

export default router;
