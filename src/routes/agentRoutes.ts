import { Router, json } from 'express';
import { db, schema } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';
import { 
  startAgent, 
  createGoal, 
  abandonGoal, 
  purchaseSlot,
  generateStrategy,
  getStrategyTasks,
  approveRoadmap,
  generateThankYou,
  approveInboxDraft,
  initializeAgent,
  updateEmpire,
  getIntelTrends
} from '../controllers/agentController.js';
import { decryptGoalFields, encryptGoalFields } from '../controllers/agentController.js';
import { userSettingsService } from '../services/userSettingsService.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/initialize', mobileAuth, initializeAgent);
router.get('/goal/latest', mobileAuth, async (req, res) => {
  try {
    const [goal] = await db.select().from(schema.goals).orderBy(desc(schema.goals.createdAt)).limit(1);
    if (!goal) return res.status(404).json({ error: 'No goals found' });
    res.json(decryptGoalFields(goal));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
router.get('/goal/:id', mobileAuth, async (req, res) => {
  try {
    const [goal] = await db.select().from(schema.goals).where(eq(schema.goals.id, req.params.id)).limit(1);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    res.json(decryptGoalFields(goal));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Alias for frontend compatibility
router.get('/empire/:id', mobileAuth, async (req, res) => {
  try {
    let goalId = String(req.params.id);
    let goal = null;
    
    // Only do UUID lookup if the ID looks like a UUID
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(goalId);
    if (isUuid) {
      [goal] = await db.select().from(schema.goals).where(eq(schema.goals.id, goalId)).limit(1);
    }
    
    // If not found (or not a UUID), fall back to the latest goal
    if (!goal) {
      [goal] = await db.select().from(schema.goals).orderBy(desc(schema.goals.createdAt)).limit(1);
    }
    
    if (!goal) return res.status(404).json({ error: 'Empire not found' });
    res.json(decryptGoalFields(goal));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
// Update empire fields (name, niche, angle, targetCustomers, businessGoals, archetype)
router.put('/empire/:id', mobileAuth, json({ type: '*/*' }), updateEmpire);
router.post('/empire/:id', mobileAuth, json({ type: '*/*' }), updateEmpire);
router.post('/start', mobileAuth, startAgent);
router.post('/goal', mobileAuth, createGoal);
router.patch('/goal/:id', mobileAuth, async (req, res) => {
  try {
    const { title, description, name, niche, angle } = req.body;
    const goalId = req.params.id;

    // 1. Update the Goal (Primary Identity)
    const updateData: any = { updatedAt: new Date() };
    if (title || name) updateData.title = title || name;
    
    // If niche/angle are provided, we should update the description as well
    if (niche || angle) {
      const [rawGoal] = await db.select().from(schema.goals).where(eq(schema.goals.id, goalId)).limit(1);
      const existingGoal = decryptGoalFields(rawGoal);
      let newDesc = description || existingGoal?.description || '';
      
      if (niche) {
        if (/Empire Niche:\s*(.*?)(?:\.|$)/.test(newDesc)) {
          newDesc = newDesc.replace(/Empire Niche:\s*(.*?)(?:\.|$)/, `Empire Niche: ${niche}.`);
        } else {
          newDesc = `Empire Niche: ${niche}. ${newDesc}`.trim();
        }
      }
      if (angle) {
        if (/Angle:\s*(.*?)(?:\.|$)/.test(newDesc)) {
          newDesc = newDesc.replace(/Angle:\s*(.*?)(?:\.|$)/, `Angle: ${angle}.`);
        } else {
          newDesc = `${newDesc} Angle: ${angle}.`.trim();
        }
      }
      updateData.description = newDesc;
    } else if (description) {
      updateData.description = description;
    }

    await db.update(schema.goals)
      .set(encryptGoalFields(updateData))
      .where(eq(schema.goals.id, goalId));

    // 2. Persist to Global User Settings for "Memory"
    const userId = (req as any).userId;
    const settingsUpdate: any = { 
      updatedAt: new Date(),
      userId: userId 
    };
    if (niche) settingsUpdate.businessNiche = niche;
    if (angle) settingsUpdate.businessAngle = angle;

    // Use saveSettings to handle upsert correctly
    if (niche || angle) {
      await userSettingsService.saveSettings(userId, {
        businessNiche: niche,
        businessAngle: angle
      });
    }
    
    res.json({ status: 'success', message: 'Empire updated and persisted' });
  } catch (error: any) {
    console.error('Update Empire Error:', error);
    res.status(500).json({ error: error.message });
  }
});
router.post('/goal/abandon', mobileAuth, abandonGoal);
router.post('/slots/purchase', mobileAuth, purchaseSlot);

router.post('/strategy/generate', mobileAuth, generateStrategy);
router.post('/strategy/approve', mobileAuth, approveRoadmap);
router.get('/strategy/:empireId', mobileAuth, getStrategyTasks);

router.post('/inbox/thank-you', mobileAuth, generateThankYou);
router.post('/inbox/approve', mobileAuth, approveInboxDraft);

// Intel / trend research endpoint
router.get('/intel/trends', mobileAuth, getIntelTrends);

// Debug: Check Canva integration status
router.get('/debug/canva-status', async (req, res) => {
  try {
    const rows = await db.select().from(schema.integrations).where(eq(schema.integrations.platform, 'canva'));
    res.json({ count: rows.length, integrations: rows.map((r: any) => ({ id: r.id, userId: r.userId, isActive: r.isActive, hasCredentials: !!r.credentials })) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
