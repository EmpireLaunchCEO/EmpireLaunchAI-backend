import { Router } from 'express';
import { startAgent } from '../controllers/agentController.js';

const router = Router();

router.post('/start', startAgent);

export default router;
