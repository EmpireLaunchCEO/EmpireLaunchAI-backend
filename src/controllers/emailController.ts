import { Request, Response } from 'express';
import { emailService } from '../services/emailService.js';
import { aiScriptingService } from '../services/aiScriptingService.js';
import { emailComplianceService } from '../services/emailComplianceService.js';

export const sendManualThankYou = async (req: Request, res: Response) => {
  try {
    const { customerEmail, productName } = req.body;
    
    if (!customerEmail || !productName) {
      return res.status(400).json({ error: 'customerEmail and productName are required' });
    }

    await emailService.sendThankYouEmail(customerEmail, productName);
    
    res.json({
      status: 'success',
      message: 'Thank you email sent successfully.'
    });
  } catch (error) {
    console.error('Error sending thank you email:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const generateDraft = async (req: Request, res: Response) => {
  try {
    const { userId, customerInquiry, businessNiche, userGoal, productName, tone } = req.body;

    if (!userId || !customerInquiry || !businessNiche || !userGoal) {
      return res.status(400).json({ error: 'userId, customerInquiry, businessNiche, and userGoal are required' });
    }

    const rawDraft = await aiScriptingService.generateEmailDraft({
      customerInquiry,
      businessNiche,
      userGoal,
      productName,
      tone
    });

    const compliantDraft = await emailComplianceService.enforceCompliance(userId, rawDraft);

    res.json({
      status: 'success',
      draft: compliantDraft
    });
  } catch (error: any) {
    console.error('Error generating email draft:', error);
    res.status(500).json({ error: error.message || 'Failed to generate email draft' });
  }
};
