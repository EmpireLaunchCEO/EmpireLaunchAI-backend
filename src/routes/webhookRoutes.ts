import { Router } from 'express';
import { etsyWebhookService } from '../services/etsyWebhookService.js';

const router = Router();

router.post('/etsy', etsyWebhookService.handleWebhook.bind(etsyWebhookService));

export default router;
