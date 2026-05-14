import { Request, Response } from 'express';
import { orchestrator } from '../agents/orchestrator.js';
import { HumanMessage } from '@langchain/core/messages';

export const startAgent = async (req: Request, res: Response) => {
  try {
    const { goal } = req.body;
    
    if (!goal) {
      return res.status(400).json({ error: 'Goal is required' });
    }

    const initialState = {
      messages: [new HumanMessage(goal)],
    };

    const result = await orchestrator.invoke(initialState);
    
    res.json({
      status: 'success',
      result,
    });
  } catch (error) {
    console.error('Error starting agent:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
