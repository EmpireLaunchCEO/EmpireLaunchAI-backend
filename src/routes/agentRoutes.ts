import { Router } from 'express';
import { startAgent, createGoal } from '../controllers/agentController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/start', mobileAuth, startAgent);
router.post('/goal', mobileAuth, createGoal);

export default router;
