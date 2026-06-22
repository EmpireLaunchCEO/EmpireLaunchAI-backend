import { Router } from 'express';
import { neuralDiscoveryController } from '../controllers/neuralDiscoveryController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/scan', mobileAuth, neuralDiscoveryController.scan);
router.post('/scan-imap', mobileAuth, neuralDiscoveryController.imapScan);
router.get('/pending/:userId', mobileAuth, neuralDiscoveryController.listPending);
router.post('/approve', mobileAuth, neuralDiscoveryController.approve);
router.post('/reject', mobileAuth, neuralDiscoveryController.reject);

export default router;
