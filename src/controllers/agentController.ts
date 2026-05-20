import { Request, Response } from 'express';
import { db, schema } from '../db/index.js';
import { aiTaskQueue } from '../services/queueService.js';
const { goals } = schema;

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
