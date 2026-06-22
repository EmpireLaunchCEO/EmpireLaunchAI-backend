import { Router } from 'express';
import { initiateVerification, verifyHandle, getVerifiedHandles } from '../controllers/verificationController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.get('/', mobileAuth, getVerifiedHandles);
router.post('/initiate', mobileAuth, initiateVerification);
router.post('/verify', mobileAuth, verifyHandle);

export default router;
