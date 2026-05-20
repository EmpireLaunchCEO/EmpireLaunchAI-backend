import { Request, Response } from 'express';
import { db } from '../db/index.js';
import { tasks, goals, empires } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';

export const getTasks = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || '00000000-0000-0000-0000-000000000000';
    
    // Join tasks with goals
    const userTasks = await db.select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      createdAt: tasks.createdAt
    })
    .from(tasks)
    .innerJoin(goals, eq(tasks.goalId, goals.id))
    .where(eq(goals.userId, userId));

    res.json(userTasks);
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateTask = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { status } = req.body;
    
    await db.update(tasks)
      .set({ status, updatedAt: new Date() })
      .where(eq(tasks.id, id));

    res.json({ status: 'success' });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getGoals = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId || '00000000-0000-0000-0000-000000000000';
    
    const userGoals = await db.select().from(goals)
      .where(eq(goals.userId, userId));
      
    res.json(userGoals);
  } catch (error) {
    console.error('Error fetching goals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
