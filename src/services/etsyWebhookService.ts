import { Request, Response } from 'express';
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
        await notificationService.sendNotification(integration.userId, {
            type: 'SALE_CONNECTED',
            title: 'New Etsy Sale!',
            message: `You just made a sale on Etsy (Receipt #${receiptId}). AI is drafting a thank you email.`,
            metadata: { receiptId, shopId }
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

            console.log(`[EtsyWebhook] AI drafted email for user ${user.id}`);
            
            // Store the draft as a notification or in a new table
            await notificationService.sendNotification(user.id, {
              type: 'EMAIL_DRAFT_READY',
              title: 'Thank You Email Drafted',
              message: `AI has prepared a thank you email for Receipt #${receiptId}. Review and send from the Gmail Assistant.`,
              metadata: { draft, receiptId }
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
