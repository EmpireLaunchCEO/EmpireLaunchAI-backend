import { Router } from 'express';
import { retentionController } from '../controllers/retentionController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.get('/drafts', mobileAuth, retentionController.getDrafts);
router.post('/respond', mobileAuth, retentionController.respond);
router.post('/scan', mobileAuth, retentionController.triggerScan);

export default router;
