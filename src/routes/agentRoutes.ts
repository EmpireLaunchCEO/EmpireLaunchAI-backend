import { Router } from 'express';
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
  initializeAgent
} from '../controllers/agentController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

router.post('/initialize', mobileAuth, initializeAgent);
router.get('/goal/latest', mobileAuth, async (req, res) => {
  try {
    const [goal] = await db.select().from(schema.goals).orderBy(desc(schema.goals.createdAt)).limit(1);
    if (!goal) return res.status(404).json({ error: 'No goals found' });
    res.json(goal);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
router.get('/goal/:id', mobileAuth, async (req, res) => {
  try {
    const [goal] = await db.select().from(schema.goals).where(eq(schema.goals.id, req.params.id)).limit(1);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    res.json(goal);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Alias for frontend compatibility
router.get('/empire/:id', mobileAuth, async (req, res) => {
  try {
    let goalId = req.params.id;
    
    let [goal] = await db.select().from(schema.goals).where(eq(schema.goals.id, goalId)).limit(1);
    
    // If not found and ID is '1' (default), try to get the latest goal
    if (!goal && goalId === '1') {
      [goal] = await db.select().from(schema.goals).orderBy(desc(schema.goals.createdAt)).limit(1);
    }
    
    if (!goal) return res.status(404).json({ error: 'Empire not found' });
    res.json(goal);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
router.post('/start', mobileAuth, startAgent);
router.post('/goal', mobileAuth, createGoal);
router.patch('/goal/:id', mobileAuth, async (req, res) => {
  try {
    const { title, description } = req.body;
    await db.update(schema.goals)
      .set({ 
        title, 
        description, 
        updatedAt: new Date() 
      })
      .where(eq(schema.goals.id, req.params.id));
    
    res.json({ status: 'success', message: 'Empire updated' });
  } catch (error: any) {
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

export default router;
