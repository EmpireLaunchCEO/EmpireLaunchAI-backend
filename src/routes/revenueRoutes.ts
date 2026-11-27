import express from 'express';
import { getInfrastructureBalances, getRevenueSummary } from '../controllers/revenueController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = express.Router();

router.get('/infrastructure', mobileAuth, getInfrastructureBalances);
router.get('/summary', mobileAuth, getRevenueSummary);

export default router;
