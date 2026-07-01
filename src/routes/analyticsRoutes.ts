import { Router } from 'express';
import { 
  getPerformanceMetrics, 
  getGrowthForecast, 
  getOpportunityCards, 
  syncAnalyticsData,
  getEmpireHealth,
  getRevenueTransactions,
  getStrategyQueue
} from '../controllers/analyticsController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.get('/performance', mobileAuth, getPerformanceMetrics);
router.get('/forecast', mobileAuth, getGrowthForecast);
router.get('/opportunities', mobileAuth, getOpportunityCards);
router.get('/empire-health', mobileAuth, getEmpireHealth);
router.get('/pulse', mobileAuth, getEmpireHealth); // Alias for frontend sync
router.get('/transactions', mobileAuth, getRevenueTransactions);
router.get('/strategies', mobileAuth, getStrategyQueue);
router.post('/sync', mobileAuth, syncAnalyticsData);

export default router;
