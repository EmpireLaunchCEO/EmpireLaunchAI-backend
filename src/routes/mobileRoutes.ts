import { Router } from 'express';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { 
  getMobileConfig, 
  syncMobileSession, 
  registerPushToken,
  getMobileDashboard 
} from '../controllers/mobileController.js';

const router = Router();

/**
 * Native App Configuration
 * Includes 'Review Mode' detection and feature flags.
 */
router.get('/config', mobileAuth, getMobileConfig);

/**
 * Mobile Session Sync
 * Generates/refreshes long-lived tokens for Capacitor persistence.
 */
router.post('/session/sync', mobileAuth, syncMobileSession);

/**
 * Native Push Registration
 * Maps FCM/APNS tokens to the authenticated user.
 */
router.post('/push/register', mobileAuth, registerPushToken);

/**
 * Mobile-Optimized Dashboard
 * Single-request batched data to minimize mobile latency.
 */
router.get('/dashboard', mobileAuth, getMobileDashboard);

export default router;
