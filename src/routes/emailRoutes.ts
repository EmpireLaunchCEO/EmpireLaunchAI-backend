import { Router } from 'express';
import { sendManualThankYou, generateDraft } from '../controllers/emailController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/thank-you', mobileAuth, sendManualThankYou);
router.post('/draft', mobileAuth, generateDraft);

export default router;
