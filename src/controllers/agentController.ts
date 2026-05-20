import { Request, Response } from 'express';
import { db, schema } from '../db/index.js';
import { aiTaskQueue } from '../services/queueService.js';
import { eq } from 'drizzle-orm';
const { goals, empires } = schema;

export const initializeEmpire = async (req: Request, res: Response) => {
  try {
    const { userId, name, niche, angle, automationMode } = req.body;

    if (!userId || !name || !niche) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create the empire
    // @ts-ignore
    const [newEmpire] = await db.insert(empires).values({
      userId,
      name,
      niche,
      angle,
      automationMode: automationMode || 'co-pilot',
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();

    // Trigger AI goal creation based on the empire identity
    const mainGoalTitle = `Launch ${name} in the ${niche} niche`;
    const mainGoalDesc = `Establish a dominant presence in ${niche} by executing on the '${angle}' angle.`;

    // @ts-ignore
    const [newGoal] = await db.insert(goals).values({
      userId,
      title: mainGoalTitle,
      description: mainGoalDesc,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();

    // Trigger initial job for the goal
    await aiTaskQueue.add('goal-initial-job', {
      goal: mainGoalTitle,
      userId,
      context: {
        empireId: newEmpire.id,
        goalId: newGoal.id,
        goal: mainGoalDesc,
      }
    });

    res.json({
      status: 'success',
      empire: newEmpire,
      goal: newGoal,
      message: 'Empire initialized and growth sequence started',
    });

  } catch (error) {
    console.error('Error initializing empire:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getEmpire = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // @ts-ignore
    const [empire] = await db.select().from(empires).where(eq(empires.id, id));
    
    if (!empire) {
      return res.status(404).json({ error: 'Empire not found' });
    }

    res.json(empire);
  } catch (error) {
    console.error('Error fetching empire:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const startAgent = async (req: Request, res: Response) => {
  try {
    const { goal, userId } = req.body;
    
    if (!goal) {
      return res.status(400).json({ error: 'Goal is required' });
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
