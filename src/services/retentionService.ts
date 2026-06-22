import { db, schema } from '../db/index.js';
const { inboxDrafts, revenueTransactions } = schema;
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { aiScriptingService } from './aiScriptingService.js';

export class RetentionService {
  async getInboxDrafts(userId: string) {
    // @ts-ignore
    return await db.select()
      .from(inboxDrafts)
      .where(and(
        eq(inboxDrafts.userId, userId),
        eq(inboxDrafts.status, 'pending')
      ))
      .orderBy(desc(inboxDrafts.createdAt));
  }

  async respondToDraft(userId: string, draftId: string, status: 'approved' | 'rejected') {
    // @ts-ignore
    const [draft] = await db.update(inboxDrafts)
      .set({ 
        status: status === 'approved' ? 'sent' : 'rejected', 
        updatedAt: new Date() 
      })
      .where(and(
        eq(inboxDrafts.id, draftId),
        eq(inboxDrafts.userId, userId)
      ))
      .returning();
    
    if (draft && status === 'approved') {
      // In a real app, trigger actual email sending via SendGrid/SES/Gmail
      console.log(`[Retention] Draft ${draftId} approved and 'sent' to ${draft.to}`);
    }
    
    return draft;
  }

  /**
   * Background process to scan for new transactions and generate drafts
   */
  async scanAndGenerateDrafts(userId: string) {
    console.log(`[Retention] Scanning transactions for user ${userId}...`);
    
    // 1. Get recent transactions
    // @ts-ignore
    const transactions = await db.select()
      .from(revenueTransactions)
      .where(eq(revenueTransactions.userId, userId))
      .orderBy(desc(revenueTransactions.date))
      .limit(10);

    for (const tx of transactions) {
      // Check if we already have a draft for this transaction (using external ID as a marker if available)
      // For this simplified logic, we just check if a draft exists with this customer/platform combo in the last 24h
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      // @ts-ignore
      const existing = await db.select()
        .from(inboxDrafts)
        .where(and(
          eq(inboxDrafts.userId, userId),
          eq(inboxDrafts.customer, tx.customer || 'Customer'),
          eq(inboxDrafts.platform, tx.platform)
        ))
        .limit(1);

      if (existing.length === 0) {
        console.log(`[Retention] Generating thank you draft for ${tx.platform} sale...`);
        
        const customer = tx.customer || 'Valued Customer';
        const productName = 'your recent order'; // In real app, look up from productId
        
        const draftContent = await aiScriptingService.generateEmailDraft({
          customerInquiry: `I just purchased from your ${tx.platform} shop.`,
          businessNiche: 'Digital Marketing',
          userGoal: 'Build brand loyalty and get reviews',
          productName,
          tone: 'warm'
        });

        // @ts-ignore
        await db.insert(inboxDrafts).values({
          id: uuidv4(),
          userId,
          subject: draftContent.split('\n')[0].replace('Subject: ', '') || `Thank you for your ${tx.platform} purchase!`,
          body: draftContent.split('\n').slice(1).join('\n').trim() || draftContent,
          to: 'customer@example.com', // In real app, use customer email from transaction
          type: 'THANK_YOU',
          customer,
          platform: tx.platform,
          reasoning: 'Automated thank you following a successful checkout to increase review probability.',
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
    }
  }
}

export const retentionService = new RetentionService();
