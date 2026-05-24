import { Router } from 'express';
import { createButton, getButtons, updateButton, deleteButton } from '../controllers/paymentButtonController.js';

const router = Router();

router.post('/', createButton);
router.get('/', getButtons);
router.patch('/:buttonId', updateButton);
router.delete('/:buttonId', deleteButton);

export default router;
