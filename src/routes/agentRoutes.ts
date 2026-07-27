import { Router, json } from 'express';
import { db, schema } from '../db/index.js';
import { eq, desc, and, sql } from 'drizzle-orm';
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
    const slot = req.query.slot !== undefined ? parseInt(req.query.slot as string, 10) : 0;
    const userId = (req as any).userId;
    const [goal] = await db.select().from(schema.goals)
      .where(and(
        eq(schema.goals.userId, userId),
        eq(schema.goals.slotIndex, slot)
      ))
      .orderBy(desc(schema.goals.createdAt)).limit(1);
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
    const userId = (req as any).userId;
    let goalId = String(req.params.id);
    let goal = null;
    
    // Only do UUID lookup if the ID looks like a UUID
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(goalId);
    if (isUuid) {
      [goal] = await db.select().from(schema.goals).where(eq(schema.goals.id, goalId)).limit(1);
    }
    
    // If not found (or not a UUID), fall back to slot-based lookup
    // '1','2','3' map to slotIndex 0,1,2
    if (!goal && /^[123]$/.test(goalId)) {
      const slotIndex = parseInt(goalId, 10) - 1;
      [goal] = await db.select().from(schema.goals)
        .where(and(
          eq(schema.goals.userId, userId),
          eq(schema.goals.slotIndex, slotIndex)
        ))
        .orderBy(desc(schema.goals.createdAt)).limit(1);
    }
    
    // Final fallback — latest goal for slot 0
    if (!goal) {
      [goal] = await db.select().from(schema.goals)
        .where(and(
          eq(schema.goals.userId, userId),
          eq(schema.goals.slotIndex, 0)
        ))
        .orderBy(desc(schema.goals.createdAt)).limit(1);
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

// Emergency migration endpoint — applies missing columns directly
router.get('/admin/apply-migrations', async (req, res) => {
  try {
    await db.execute(sql`ALTER TABLE goals ADD COLUMN IF NOT EXISTS slot_index INTEGER DEFAULT 0`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS subscriptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), type TEXT DEFAULT 'subscription', stripe_session_id TEXT, amount INTEGER, paid_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW())`);
    await db.execute(sql`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`);
    await db.execute(sql`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMP`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS master_assets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES users(id), campaign_id UUID, style_dna JSONB, style_dna_source TEXT, style_dna_strand_ids JSONB, asset_type TEXT NOT NULL, status TEXT DEFAULT 'completed', master_video_url TEXT, master_image_url TEXT, master_pdf_url TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    // Clean up old stuck approvals with no video
    await db.delete(schema.approvals).where(eq(schema.approvals.id, '0ce84455-51ee-4342-864c-2b9d090b8acc'));
    await db.delete(schema.approvals).where(eq(schema.approvals.id, '8b06f2fd-c182-4a82-bc71-008a991ada86'));
    res.json({ status: 'migrations applied + cleaned 2 stuck approvals' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: Look up user by email to diagnose cross-browser identity issues
router.get('/debug/user-by-email', async (req, res) => {
  try {
    const email = req.query.email as string;
    if (!email) return res.status(400).json({ error: 'email query param required' });
    
    const rows = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    const user = rows[0] || null;
    if (!user) return res.status(404).json({ error: 'User not found', email });
    
    // Also check if there are goals for this user
    const goalRows = await db.select({ id: schema.goals.id, title: schema.goals.title, slotIndex: schema.goals.slotIndex })
      .from(schema.goals).where(eq(schema.goals.userId, user.id)).limit(10);
    
    res.json({ 
      user: { id: user.id, email: user.email, tier: user.tier },
      goals: goalRows.map((g: any) => ({ id: g.id, title: g.title, slot: g.slotIndex })),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

export default router;
