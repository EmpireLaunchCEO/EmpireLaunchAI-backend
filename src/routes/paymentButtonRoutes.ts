import { Router } from 'express';
import { createButton, getButtons, updateButton, deleteButton } from '../controllers/paymentButtonController.js';
import { protectedButtonController } from '../controllers/protectedButtonController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/', createButton);
router.get('/', getButtons);
router.patch('/:buttonId', updateButton);
router.delete('/:buttonId', deleteButton);

// Protected Payment Button Proxy
router.post('/protected/generate', mobileAuth, protectedButtonController.generate);
router.get('/protected/resolve/:buttonId', protectedButtonController.resolve);

export default router;
