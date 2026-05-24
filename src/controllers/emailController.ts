import { Request, Response } from 'express';
import { emailService } from '../services/emailService.js';
import { aiScriptingService } from '../services/aiScriptingService.js';
import { emailComplianceService } from '../services/emailComplianceService.js';
import { gmailService } from '../services/gmailService.js';
import { integrationService } from '../services/integrationService.js';

export const listGmailMessages = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const credentials = await integrationService.getCredentials(userId, 'gmail');
    if (!credentials || !credentials.access_token) {
      return res.status(401).json({ error: 'Gmail not integrated' });
    }

    const messages = await gmailService.listMessages(credentials.access_token);
    res.json(messages);
  } catch (error: any) {
    console.error('Error listing Gmail messages:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getGmailMessage = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const { messageId } = req.params;
    if (!messageId || typeof messageId !== 'string') {
        return res.status(400).json({ error: 'Invalid messageId' });
    }
    const credentials = await integrationService.getCredentials(userId, 'gmail');
    if (!credentials || !credentials.access_token) {
      return res.status(401).json({ error: 'Gmail not integrated' });
    }

    const message = await gmailService.getMessage(credentials.access_token, messageId);
    res.json(message);
  } catch (error: any) {
    console.error('Error fetching Gmail message:', error);
    res.status(500).json({ error: error.message });
  }
};

export const sendGmailEmail = async (req: Request, res: Response) => {
  try {
    const userId = req.headers['x-user-id'] as string || 'default-user';
    const { to, subject, body } = req.body;
    const credentials = await integrationService.getCredentials(userId, 'gmail');
    if (!credentials || !credentials.access_token) {
      return res.status(401).json({ error: 'Gmail not integrated' });
    }

    const result = await gmailService.sendEmail(credentials.access_token, to, subject, body);
    res.json(result);
  } catch (error: any) {
    console.error('Error sending Gmail email:', error);
    res.status(500).json({ error: error.message });
  }
};

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
