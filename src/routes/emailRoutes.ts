import { Router } from 'express';
import { sendManualThankYou, generateDraft, listGmailMessages, getGmailMessage, sendGmailEmail } from '../controllers/emailController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/thank-you', mobileAuth, sendManualThankYou);
router.post('/draft', mobileAuth, generateDraft);
router.get('/gmail/messages', mobileAuth, listGmailMessages);
router.get('/gmail/messages/:messageId', mobileAuth, getGmailMessage);
router.post('/gmail/send', mobileAuth, sendGmailEmail);

export default router;
