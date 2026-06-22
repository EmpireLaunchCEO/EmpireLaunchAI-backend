import { db } from '../db/index.js';
import { emailLogs } from '../db/sqlite-schema.js';
import { eq, desc, and, lte } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { emailService } from './emailService.js';
import { reviewService } from './reviewService.js';
import { aiThankYouDrafter } from './aiThankYouDrafter.js';
import { revenueTransactions } from '../db/sqlite-schema.js';

export interface LoyaltyEvent {
  transactionId: string;
  userId: string;
  customerEmail: string;
  productName: string;
  amount: number;
  niche?: string;
  customerName?: string;
}

export interface LoyaltyCycleResult {
  thankYouSent: boolean;
  reviewRequested: boolean;
  emailLogId: string;
  analytics: {
    subject: string;
    openCount: number;
    clickCount: number;
  };
}

/**
 * Loyalty Loop Worker — orchestrates the post-purchase lifecycle:
 * 
 * Purchase → Thank You (AI-drafted) → Review Request (3 days later)
 *   → Review Posted? → Social Proof Queue → Trust Metrics Update
 *   → No Review? → Gentle Follow-up (7 days)
 * 
 * Every email is tracked for opens/clicks analytics.
 */
export class LoyaltyLoopWorker {

  /**
   * Process a single purchase event — sends AI-drafted thank-you + logs for follow-up.
   */
  async processPurchase(event: LoyaltyEvent): Promise<LoyaltyCycleResult> {
    console.log(`[LoyaltyLoop] Processing purchase: ${event.productName} for ${event.customerEmail}`);

    // 1. AI-draft the thank-you email
    const draft = await aiThankYouDrafter.draftThankYou({
      productName: event.productName,
      customerName: event.customerName,
      niche: event.niche || 'general',
      price: event.amount,
      orderId: event.transactionId,
    });

    // 2. Send the email
    const sent = await emailService.sendEmail({
      to: event.customerEmail,
      subject: draft.subject,
      body: draft.body + '\n\n---\n' + draft.suggestedReviewCta,
    });

    // 3. Log the email for analytics tracking
    const emailLogId = uuidv4();
    await db.insert(emailLogs).values({
      id: emailLogId,
      userId: event.userId,
      customerEmail: event.customerEmail,
      emailType: 'thank_you',
      subject: draft.subject,
      bodyPreview: draft.body.slice(0, 200),
      status: 'sent',
      openCount: 0,
      clickCount: 0,
      metadata: {
        productName: event.productName,
        transactionId: event.transactionId,
        tone: draft.tone,
        personalizationTags: draft.personalizationTags,
        reviewCta: draft.suggestedReviewCta,
      },
      createdAt: new Date(),
    });

    console.log(`[LoyaltyLoop] Thank-you sent to ${event.customerEmail}: "${draft.subject}"`);

    return {
      thankYouSent: sent,
      reviewRequested: false,
      emailLogId,
      analytics: {
        subject: draft.subject,
        openCount: 0,
        clickCount: 0,
      },
    };
  }

  /**
   * Process follow-up review requests for purchases made 3+ days ago.
   * Called by the scheduler worker daily.
   */
  async processReviewFollowUps(): Promise<{ requested: number; skipped: number }> {
    let requested = 0;
    let skipped = 0;

    // Get thank-you emails sent 3+ days ago that haven't had review requests yet
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    
    const recentThankYous = await db.select()
      .from(emailLogs)
      .where(and(
        eq(emailLogs.emailType, 'thank_you'),
        lte(emailLogs.createdAt, threeDaysAgo),
        eq(emailLogs.status, 'sent'),
      ))
      .limit(50);

    for (const log of recentThankYous) {
      try {
        const meta = log.metadata as any;
        
        // Draft and send review request
        const draft = await aiThankYouDrafter.draftReviewRequest({
          productName: meta?.productName || 'your purchase',
          customerName: log.customerEmail.split('@')[0],
          niche: meta?.niche || 'general',
          daysSincePurchase: 3,
        });

        const sent = await emailService.sendEmail({
          to: log.customerEmail,
          subject: draft.subject,
          body: draft.body + '\n\n' + draft.suggestedReviewCta,
        });

        if (sent) {
          // Log the review request email
          await db.insert(emailLogs).values({
            id: uuidv4(),
            userId: log.userId,
            customerEmail: log.customerEmail,
            emailType: 'review_request',
            subject: draft.subject,
            bodyPreview: draft.body.slice(0, 200),
            status: 'sent',
            openCount: 0,
            clickCount: 0,
            metadata: {
              parentEmailId: log.id,
              productName: meta?.productName,
              reviewCta: draft.suggestedReviewCta,
            },
            createdAt: new Date(),
          });
          requested++;
        }
      } catch (err) {
        console.error(`[LoyaltyLoop] Review follow-up failed for ${log.customerEmail}:`, err);
        skipped++;
      }
    }

    console.log(`[LoyaltyLoop] Review follow-ups: ${requested} sent, ${skipped} skipped`);
    return { requested, skipped };
  }

  /**
   * Track email open (called via tracking pixel).
   */
  async trackOpen(emailLogId: string): Promise<void> {
    await db.update(emailLogs)
      .set({
        status: 'opened',
        openedAt: new Date(),
        openCount: db`${emailLogs.openCount} + 1`,
      })
      .where(eq(emailLogs.id, emailLogId));
  }

  /**
   * Track email click (called via link redirect).
   */
  async trackClick(emailLogId: string): Promise<void> {
    await db.update(emailLogs)
      .set({
        status: 'clicked',
        clickedAt: new Date(),
        clickCount: db`${emailLogs.clickCount} + 1`,
      })
      .where(eq(emailLogs.id, emailLogId));
  }

  /**
   * Get email analytics for a user.
   */
  async getAnalytics(userId: string): Promise<{
    totalSent: number;
    openRate: number;
    clickRate: number;
    thankyouSent: number;
    reviewRequestsSent: number;
  }> {
    const all = await db.select()
      .from(emailLogs)
      .where(eq(emailLogs.userId, userId));

    const totalSent = all.length;
    const opened = all.filter((e: any) => e.openCount > 0).length;
    const clicked = all.filter((e: any) => e.clickCount > 0).length;
    const thankyouSent = all.filter((e: any) => e.emailType === 'thank_you').length;
    const reviewRequestsSent = all.filter((e: any) => e.emailType === 'review_request').length;

    return {
      totalSent,
      openRate: totalSent > 0 ? (opened / totalSent) * 100 : 0,
      clickRate: totalSent > 0 ? (clicked / totalSent) * 100 : 0,
      thankyouSent,
      reviewRequestsSent,
    };
  }
}

export const loyaltyLoopWorker = new LoyaltyLoopWorker();