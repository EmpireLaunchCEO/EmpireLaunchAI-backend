import { Router } from 'express';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { businessSetupService } from '../services/businessSetupService.js';

const router = Router();

/**
 * GET /api/setup/plan
 * Generate a business setup plan for a client.
 */
router.get('/plan', mobileAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { niche = 'general', platform = 'general' } = req.query;
    const plan = await businessSetupService.generateSetupPlan(
      userId,
      niche as string,
      platform as string
    );
    res.json(plan);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/setup/step/:stepId/complete
 * Mark a setup step as completed.
 */
router.post('/step/:stepId/complete', mobileAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    await businessSetupService.completeStep(userId, req.params.stepId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;