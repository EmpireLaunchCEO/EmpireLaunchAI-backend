import { db, schema } from '../db/index.js';
import { etsyService } from './etsyService.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { aiScriptingService } from './aiScriptingService.js';
import { notificationService } from './notificationService.js';

export class EtsyPollingService {
  /**
   * Polls all active Etsy shops for new sales receipts.
   */
  async pollAllShops() {
    console.log('[EtsyPolling] Polling all active Etsy shops...');
    
    // 1. Get all active Etsy integrations
    const integrations = await db.select()
      .from(schema.integrations)
      .where(eq(schema.integrations.platform, 'etsy'));

    for (const integration of integrations) {
      try {
        const credentials = integration.credentials as any;
        if (!credentials?.access_token || !integration.platformAccountId) continue;

        // 2. Fetch recent sales from Etsy API
        const receipts = await etsyService.getRecentSales(credentials.access_token, integration.platformAccountId);
        
        if (receipts && receipts.length > 0) {
          console.log(`[EtsyPolling] Found ${receipts.length} receipts for shop ${integration.platformAccountId}`);
          // In a real implementation, we would check which ones are new
          // For now, we just process the latest one as a demo of the flow
          await this.processNewSale(integration.userId, receipts[0]);
        }
      } catch (error) {
        console.error(`[EtsyPolling] Failed to poll shop ${integration.platformAccountId}:`, error);
      }
    }
  }

  private async processNewSale(userId: string, receipt: any) {
    const receiptId = receipt.receipt_id;
    console.log(`[EtsyPolling] Processing new sale: Receipt #${receiptId} for user ${userId}`);

    // Trigger AI draft flow (similar to webhook)
    try {
      const [goal] = await db.select().from(schema.goals).where(and(eq(schema.goals.userId, userId), eq(schema.goals.status, 'active'))).limit(1);
      
      if (goal) {
        const draft = await aiScriptingService.generateEmailDraft({
          customerInquiry: `New purchase on Etsy: Receipt #${receiptId}`,
          businessNiche: goal.title,
          userGoal: goal.description || "Satisfy customer and build trust",
          productName: "purchased item"
        });

        // Store in approvals
        await db.insert(schema.approvals).values({
          id: uuidv4(),
          userId: userId,
          type: 'email',
          status: 'pending',
          payload: {
            recipient: receipt.buyer_email || 'customer@example.com',
            subject: draft.split('\n')[0].replace('Subject: ', ''),
            body: draft.split('\n').slice(1).join('\n').trim(),
            platform: 'gmail',
            receiptId
          },
          createdAt: new Date(),
          updatedAt: new Date()
        });

        await notificationService.notifyUser(userId, `New Etsy Sale! AI has drafted a thank you email for Receipt #${receiptId}.`, false);
      }
    } catch (error) {
      console.error('[EtsyPolling] Failed to process new sale:', error);
    }
  }
}

export const etsyPollingService = new EtsyPollingService();
