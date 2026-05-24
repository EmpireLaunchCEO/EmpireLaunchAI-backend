import { Router } from 'express';
import { 
  getPerformanceMetrics, 
  getGrowthForecast, 
  getOpportunityCards, 
  syncAnalyticsData,
  getEmpirePulse
} from '../controllers/analyticsController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.get('/performance', mobileAuth, getPerformanceMetrics);
router.get('/forecast', mobileAuth, getGrowthForecast);
router.get('/opportunities', mobileAuth, getOpportunityCards);
router.get('/pulse', mobileAuth, getEmpirePulse);
router.post('/sync', mobileAuth, syncAnalyticsData);

export default router;
