import { Request, Response } from 'express';
import { db, schema } from '../db/index.js';
import { aiTaskQueue, onboardingQueue } from '../services/queueService.js';
import { fraudSentinel } from '../services/fraudSentinel.js';
import { strategyOrchestrator } from '../services/strategyOrchestrator.js';
import { inboxAssistantService } from '../services/inboxAssistantService.js';
import { eq, and, count, inArray } from 'drizzle-orm';
import { userSettingsService } from './userSettingsController.js';
const { goals, users, approvals, tasks } = schema;

export const initializeAgent = async (req: Request, res: Response) => {
  try {
    const { userId, name, niche, angle, automationMode } = req.body;
    
    if (!userId || !name || !niche) {
      return res.status(400).json({ error: 'Missing required fields: userId, name, niche' });
    }

    // 0. Ensure user exists (Upsert logic for onboarding)
    const [existingUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!existingUser) {
      await db.insert(users).values({
        id: userId,
        email: 'stacipeabody@gmail.com', // Default for onboarding
        termsAcceptedVersion: 1,
        businessSlots: 3,
        tier: 'BETA_TESTER',
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    // Security check: Fraud Sentinel
    const isSuspicious = await fraudSentinel.scanForAbuse(userId, { name, niche, angle });
    if (isSuspicious) {
      return res.status(403).json({ error: 'Account locked due to suspicious activity' });
    }

    // Check for existing goal with same name to prevent duplicates on retry
    const [existingGoal] = await db.select().from(goals).where(
      and(
        eq(goals.userId, userId),
        eq(goals.title, name)
      )
    ).limit(1);

    if (existingGoal) {
      return res.json({
        status: 'success',
        empire: existingGoal,
        message: 'Empire already exists, resuming sync'
      });
    }

    // 1. Create the primary goal (The Empire) with PENDING status immediately
    // This allows the frontend to have an ID to track progress
    const [newGoal] = await db.insert(goals).values({
      userId,
      title: name,
      description: `Empire Niche: ${niche}. Angle: ${angle}. Mode: ${automationMode}`,
      status: 'pending', // Will be set to 'active' by the worker
      approvalRequired: automationMode !== 'full_autopilot',
      autoPost: automationMode === 'full_autopilot',
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();

    // 1.5 Sync to User Settings for global memory
    await userSettingsService.saveSettings(userId, {
      businessNiche: niche,
      businessAngle: angle
    });

    // 2. Add initialize-agent task to the queue for heavy processing (AI, provisioning)
    const job = await onboardingQueue.add('initialize-agent', {
      userId,
      goalId: newGoal.id, // Pass the existing goal ID
      name,
      niche,
      angle,
      automationMode
    });

    res.json({
      status: 'success',
      jobId: job.id,
      empire: newGoal,
      message: 'Empire initialization has been queued'
    });
  } catch (error: any) {
    console.error('Error initializing agent:', error);
    res.status(500).json({ error: error.message });
  }
};

export const startAgent = async (req: Request, res: Response) => {
  try {
    const { goal, userId } = req.body;
    
    if (!goal) {
      return res.status(400).json({ error: 'Goal is required' });
    }

    // Security check: Fraud Sentinel
    const isSuspicious = await fraudSentinel.scanForAbuse(userId, { goal });
    if (isSuspicious) {
      return res.status(403).json({ error: 'Account locked due to suspicious activity' });
    }

    const job = await aiTaskQueue.add('start-agent-job', {
      goal,
      userId: userId || 'default-user',
      context: {
        goal
      }
    });
    
    res.json({
      status: 'success',
      message: 'AI task has been queued',
      jobId: job.id,
    });
  } catch (error) {
    console.error('Error starting agent:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createGoal = async (req: Request, res: Response) => {
  try {
    const { userId, title, description, approvalRequired, autoPost } = req.body;
    
    if (!userId || !title) {
      return res.status(400).json({ error: 'UserId and title are required' });
    }

    // 1. Check User Status (Locked and T&C)
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isLocked) return res.status(403).json({ error: 'Account is locked' });
    
    // T&C Check
    const CURRENT_TERMS_VERSION = 1;
    if (user.termsAcceptedVersion < CURRENT_TERMS_VERSION) {
      return res.status(403).json({ error: 'Terms and Conditions must be accepted first' });
    }

    // 2. Enforce Business Limit (Max active businesses = user.businessSlots)
    const activeGoals = await db.select({ value: count() })
      .from(goals)
      .where(and(eq(goals.userId, userId), eq(goals.status, 'active')));
    
    const activeCount = activeGoals[0]?.value || 0;
    const tier = user.tier || 'STANDARD_USER';
    const isUnlimited = tier === 'OWNER_MASTER' || tier === 'BETA_TESTER';

    if (!isUnlimited && activeCount >= user.businessSlots) {
      return res.status(402).json({ 
        error: 'Active business limit reached', 
        limit: user.businessSlots,
        message: 'Abandon an existing business or purchase a new slot for $30.'
      });
    }

    // 3. Fraud Sentinel check on goal creation
    const isSuspicious = await fraudSentinel.scanForAbuse(userId, { title, description });
    if (isSuspicious) {
      return res.status(403).json({ error: 'Account locked due to suspicious activity' });
    }

    // @ts-ignore
    const [newGoal] = await db.insert(goals).values({
      userId,
      title,
      description,
      approvalRequired: approvalRequired ?? true,
      autoPost: autoPost ?? false,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();

    // Trigger initial job for the goal
    await aiTaskQueue.add('goal-initial-job', {
      goal: title,
      userId,
      context: {
        goalId: newGoal.id,
        goal: description || title,
        approvalRequired: newGoal.approvalRequired,
        autoPost: newGoal.autoPost
      }
    });

    res.json({
      status: 'success',
      goal: newGoal,
      message: 'Goal created and initial processing queued',
    });
  } catch (error) {
    console.error('Error creating goal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const abandonGoal = async (req: Request, res: Response) => {
  try {
    const { userId, goalId } = req.body;
    
    if (!userId || !goalId) {
      return res.status(400).json({ error: 'UserId and goalId are required' });
    }

    const [goal] = await db.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.userId, userId))).limit(1);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    // "Abandonment/Archiving" protocol
    await db.update(goals)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(goals.id, goalId));
    
    // In a real system, we would snapshot state to cold storage here.
    console.log(`Goal ${goalId} archived for user ${userId}`);

    res.json({
      status: 'success',
      message: 'Business abandoned. Slot is now free.',
      goalId
    });
  } catch (error) {
    console.error('Error abandoning goal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const purchaseSlot = async (req: Request, res: Response) => {
  try {
    const { userId } = req.body;
    
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // STANDARD_USER limit check (Max 3)
    if (user.tier === 'STANDARD_USER' && user.businessSlots >= 3) {
      return res.status(400).json({ error: 'Maximum business slot limit (3) reached for standard accounts.' });
    }

    // @ts-ignore
    const [approval] = await db.insert(approvals).values({
      id: crypto.randomUUID(),
      userId,
      type: 'financial',
      status: 'pending',
      payload: {
        type: 'SLOT_PURCHASE',
        amount: 3000, // $30.00
        message: `Purchase business slot #${user.businessSlots + 1} for $30.`
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    res.json({
      status: 'success',
      message: 'Slot purchase request created. Approve in dashboard to unlock.',
      approvalId: approval.id
    });
  } catch (error) {
    console.error('Error purchasing slot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const generateStrategy = async (req: Request, res: Response) => {
  try {
    const empireId = req.body.empireId;
    if (typeof empireId !== 'string') {
      return res.status(400).json({ error: 'Empire ID is required' });
    }

    const { createdTasks, approvalId } = await strategyOrchestrator.generateGrowthRoadmap(empireId);
    
    res.json({
      status: 'success',
      message: 'Strategic growth roadmap generated. Please approve to proceed.',
      approvalId,
      tasks: createdTasks
    });
  } catch (error: any) {
    console.error('Error generating strategy:', error);
    res.status(500).json({ error: error.message });
  }
};

export const approveRoadmap = async (req: Request, res: Response) => {
  try {
    const { approvalId, decisionDetails } = req.body;
    if (!approvalId) {
      return res.status(400).json({ error: 'Approval ID is required' });
    }

    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    if (!approval) return res.status(404).json({ error: 'Approval record not found' });
    if (approval.status !== 'pending') return res.status(400).json({ error: 'Approval already processed' });

    const payload = approval.payload as any;
    const taskIds = payload.taskIds;

    // Bulk update tasks to 'todo'
    await db.update(tasks)
      .set({ status: 'todo', updatedAt: new Date() })
      .where(inArray(tasks.id, taskIds));

    // Update approval record
    await db.update(approvals)
      .set({ status: 'approved', decisionDetails, updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));

    res.json({
      status: 'success',
      message: 'Strategic roadmap approved. Tasks moved to Todo.',
      taskIds
    });
  } catch (error: any) {
    console.error('Error approving roadmap:', error);
    res.status(500).json({ error: error.message });
  }
};

export const generateThankYou = async (req: Request, res: Response) => {
  try {
    const { userId, customerName, itemName, platform } = req.body;
    if (!userId || !customerName || !itemName || !platform) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { approvalId, draft } = await inboxAssistantService.generateThankYouDraft(userId, customerName, itemName, platform);

    res.json({
      status: 'success',
      message: 'Thank you draft generated',
      approvalId,
      draft
    });
  } catch (error: any) {
    console.error('Error generating thank you:', error);
    res.status(500).json({ error: error.message });
  }
};

export const approveInboxDraft = async (req: Request, res: Response) => {
  try {
    const { approvalId, decisionDetails } = req.body;
    if (!approvalId) {
      return res.status(400).json({ error: 'Approval ID is required' });
    }

    await db.update(approvals)
      .set({ status: 'approved', decisionDetails, updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));

    // In a real scenario, this would trigger the actual email/message sending service.
    
    res.json({
      status: 'success',
      message: 'Inbox draft approved'
    });
  } catch (error: any) {
    console.error('Error approving inbox draft:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getStrategyTasks = async (req: Request, res: Response) => {
  try {
    const empireId = req.params.empireId;
    if (typeof empireId !== 'string') {
      return res.status(400).json({ error: 'Empire ID is required' });
    }

    const strategyTasks = await strategyOrchestrator.getStrategicTasks(empireId);
    
    res.json({
      status: 'success',
      tasks: strategyTasks
    });
  } catch (error: any) {
    console.error('Error fetching strategy tasks:', error);
    res.status(500).json({ error: error.message });
  }
};
