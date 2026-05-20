import { Request, Response } from 'express';
import { approvalService } from '../services/approvalService.js';

export const getPendingApprovals = async (req: Request, res: Response) => {
  // Logic to fetch pending approvals for a user
  res.json({ status: 'success', approvals: [] });
};

export const respondToApproval = async (req: Request, res: Response) => {
  try {
    const { requestId, status } = req.body;
    if (!requestId || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid requestId or status' });
    }
    const result = await approvalService.respondToRequest(requestId, status);
    res.json({ status: 'success', result });
  } catch (error) {
    console.error('Error responding to approval:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
