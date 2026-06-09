import express from 'express';
import { getInfrastructureBalances, getRevenueSummary } from '../controllers/revenueController.js';

const router = express.Router();

router.get('/infrastructure', getInfrastructureBalances);
router.get('/summary', getRevenueSummary);

export default router;
