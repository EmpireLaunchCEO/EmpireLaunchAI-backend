import { Router } from 'express';
import { campaignController } from '../controllers/campaignController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

// Reschedule a post (Conversational Rescheduling)
router.post('/reschedule', mobileAuth, campaignController.reschedule);

// Manually trigger processing of due posts
router.post('/process-due', mobileAuth, campaignController.processDue);

export default router;
