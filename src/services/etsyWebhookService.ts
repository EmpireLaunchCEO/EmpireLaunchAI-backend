import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
const { notifications, users, goals } = schema;
import { notificationService } from './notificationService.js';
import { gmailService } from './gmailService.js';
import { aiScriptingService } from './aiScriptingService.js';
import { eq, and } from 'drizzle-orm';

export class EtsyWebhookService {
  async handleWebhook(req: Request, res: Response) {
    const event = req.body;
    console.log('[EtsyWebhook] Received event:', event.event_type);

    // Etsy v3 webhooks verification (simplified for implementation)
    // In production, we would verify the X-Etsy-Signature header
    
    if (event.event_type === 'verified') {
        return res.status(200).send();
    }

    if (event.event_type === 'shop.receipt.created') {
      const receiptId = event.resource_id;
      const shopId = event.shop_id;
      
      console.log(`[EtsyWebhook] New sale! Receipt: ${receiptId} in Shop: ${shopId}`);

      // 1. Notify the user
      // We would find the user associated with this shopId
      const results = await db.select()
        .from(schema.integrations)
        .where(and(
            eq(schema.integrations.platform, 'etsy'),
            eq(schema.integrations.platformAccountId, shopId.toString())
        ))
        .limit(1);

      const integration = results[0];

      if (integration) {
        await notificationService.sendPushNotification(integration.userId, {
            title: 'New Etsy Sale!',
            body: `You just made a sale on Etsy (Receipt #${receiptId}). AI is drafting a thank you email.`,
            data: { url: '/dashboard', type: 'SALE_ALERT' }
        });
        
        // 2. Trigger Post-Purchase Automation (Queue a task)
        // This would involve drafting an email via AI
        try {
          const [user] = await db.select().from(users).where(eq(users.id, integration.userId)).limit(1);
          const [goal] = await db.select().from(goals).where(and(eq(goals.userId, integration.userId), eq(goals.status, 'active'))).limit(1); // Get first active goal for context
          
          if (user && goal) {
            const draft = await aiScriptingService.generateEmailDraft({
              customerInquiry: `New purchase on Etsy: Receipt #${receiptId}`,
              businessNiche: goal.title,
              userGoal: goal.description || "Satisfy customer and build trust",
              productName: "purchased item"
            });

            // Store the draft in the Approvals table
            const approvalId = uuidv4();
            await db.insert(schema.approvals).values({
              id: approvalId,
              userId: integration.userId,
              type: 'email',
              status: 'pending',
              payload: {
                recipient: 'customer@example.com', // In real flow, get from receipt resource
                subject: draft.split('\n')[0].replace('Subject: ', ''),
                body: draft.split('\n').slice(1).join('\n').trim(),
                platform: 'gmail',
                receiptId
              },
              createdAt: new Date(),
              updatedAt: new Date()
            });

            console.log(`[EtsyWebhook] AI drafted email and created approval ${approvalId} for user ${user.id}`);
            
            // Store the draft as a notification
            await notificationService.sendPushNotification(user.id, {
              title: 'Thank You Email Drafted',
              body: `AI has prepared a thank you email for Receipt #${receiptId}. Review and send from your Control Gates.`,
              data: { url: '/dashboard', type: 'GENERAL' }
            });
          }
        } catch (error) {
          console.error('[EtsyWebhook] Failed to generate AI draft:', error);
        }
      }
    }

    res.status(200).send();
  }
}

export const etsyWebhookService = new EtsyWebhookService();
