import { Router } from 'express';
import { protectedButtonController } from '../controllers/protectedButtonController.js';

const router = Router();

// Endpoint for Protected Payment Button resolution
// Expected: /api/protected-button/resolve/:buttonId?ott=...
router.get('/resolve/:buttonId', protectedButtonController.resolveProxy.bind(protectedButtonController));

export default router;
