import { Router } from 'express';
import { runDiscovery, getPendingDiscoveries, approveDiscovery, rejectDiscovery } from '../controllers/discoveryController.js';

const router = Router();

router.post('/run', runDiscovery);
router.get('/pending', getPendingDiscoveries);
router.post('/approve/:discoveryId', approveDiscovery);
router.post('/reject/:discoveryId', rejectDiscovery);

export default router;
