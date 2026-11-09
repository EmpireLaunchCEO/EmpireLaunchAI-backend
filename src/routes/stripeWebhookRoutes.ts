/**
 * Stripe webhook router.
 *
 * The body parser is `express.raw({ type: 'application/json' })` and it lives
 * HERE, on this path only, so the handler sees the exact bytes Stripe signed.
 * index.ts mounts this router BEFORE its global `express.json()`, because once
 * the JSON parser has re-serialised the body the signature can never match.
 */
import express, { Router } from 'express';
import { handleStripeWebhook } from '../controllers/stripeWebhookController.js';

const router = Router();

const rawJsonBody = express.raw({ type: 'application/json' });

router.post('/', rawJsonBody, handleStripeWebhook);
router.post('', rawJsonBody, handleStripeWebhook);

export default router;
