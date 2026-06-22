import { Router } from 'express';
import { createKittlBlueprint, createCapCutBlueprint } from '../controllers/blueprintController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/kittl', mobileAuth, createKittlBlueprint);
router.post('/capcut', mobileAuth, createCapCutBlueprint);

export default router;
