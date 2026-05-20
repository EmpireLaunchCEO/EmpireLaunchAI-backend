import { startAgent, createGoal, initializeEmpire, getEmpire } from '../controllers/agentController.js';

const router = Router();

router.post('/initialize', mobileAuth, initializeEmpire);
router.get('/empire/:id', mobileAuth, getEmpire);
router.post('/start', mobileAuth, startAgent);
router.post('/goal', mobileAuth, createGoal);

export default router;
