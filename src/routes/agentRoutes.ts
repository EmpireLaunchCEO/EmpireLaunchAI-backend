import { Router } from 'express';
import { 
  startAgent, 
  createGoal, 
  abandonGoal, 
  purchaseSlot,
  generateStrategy,
  getStrategyTasks,
  approveRoadmap,
  generateThankYou,
  approveInboxDraft
} from '../controllers/agentController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/start', mobileAuth, startAgent);
router.post('/goal', mobileAuth, createGoal);
router.post('/goal/abandon', mobileAuth, abandonGoal);
router.post('/slots/purchase', mobileAuth, purchaseSlot);

router.post('/strategy/generate', mobileAuth, generateStrategy);
router.post('/strategy/approve', mobileAuth, approveRoadmap);
router.get('/strategy/:empireId', mobileAuth, getStrategyTasks);

router.post('/inbox/thank-you', mobileAuth, generateThankYou);
router.post('/inbox/approve', mobileAuth, approveInboxDraft);

export default router;
