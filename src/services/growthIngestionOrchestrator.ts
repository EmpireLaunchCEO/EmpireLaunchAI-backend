import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { etsyService } from './etsyService.js';
import { tiktokService } from './tiktokService.js';
import { integrationService } from './integrationService.js';
import { revenueOracle } from './revenueOracle.js';

/**
 * Growth Ingestion Orchestrator
 * 
 * Background ingestion engine that polls Etsy and TikTok for new sales
 * and engagement data, then feeds it into the Revenue Oracle for
 * milestone processing and thank-you email automation.
 * 
 * This fulfills the business plan promise of "tracking growth across all apps"
 * by autonomously pulling from each integrated platform.
 */
export class GrowthIngestionOrchestrator {

  /**
   * Full ingestion cycle — polls all platforms for all users.
   * Called by the SchedulerWorker on a cron interval.
   */
  async runIngestionCycle(): Promise<{
    usersProcessed: number;
    etsySalesFound: number;
    tiktokVideosFound: number;
    errors: string[];
  }> {
    console.log('[GrowthIngestion] Starting ingestion cycle...');
    const errors: string[] = [];
    let usersProcessed = 0;
    let etsySalesFound = 0;
    let tiktokVideosFound = 0;

    try {
      // Find all users with platform integrations
      const integratedUsers = await db.select()
        .from(schema.integrations)
        .where(eq(schema.integrations.isActive, true));

      // Group by userId to avoid duplicate processing
      const userIds = [...new Set(integratedUsers.map((i: any) => i.userId as string))] as string[];

      for (const userId of userIds) {
        usersProcessed++;
        try {
          const userIntegrations = integratedUsers.filter((i: any) => i.userId === userId);

          for (const integration of userIntegrations) {
            const platform = integration.platform.toLowerCase();

            if (platform === 'etsy') {
              const count = await this.ingestEtsySales(userId, integration.id);
              etsySalesFound += count;
            } else if (platform === 'tiktok_display' || platform === 'tiktok') {
              const count = await this.ingestTikTokEngagement(userId);
              tiktokVideosFound += count;
            }
          }
        } catch (err: any) {
          errors.push(`User ${userId}: ${err.message}`);
          console.error(`[GrowthIngestion] Error processing user ${userId}:`, err.message);
        }
      }
    } catch (err: any) {
      errors.push(`Cycle error: ${err.message}`);
      console.error('[GrowthIngestion] Cycle error:', err.message);
    }

    console.log(`[GrowthIngestion] Cycle complete: ${usersProcessed} users, ${etsySalesFound} Etsy sales, ${tiktokVideosFound} TikTok videos. Errors: ${errors.length}`);
    return { usersProcessed, etsySalesFound, tiktokVideosFound, errors };
  }

  /**
   * Ingests Etsy sales data for a user.
   * Fetches recent receipts and feeds into Revenue Oracle.
   */
  private async ingestEtsySales(userId: string, integrationId: string): Promise<number> {
    const credentials = await integrationService.getCredentials(userId, 'etsy');
    if (!credentials || !credentials.access_token) {
      console.log(`[GrowthIngestion] No Etsy credentials for user ${userId}`);
      return 0;
    }

    // Get the shopId from the integration's platformAccountId
    const [integration] = await db.select()
      .from(schema.integrations)
      .where(eq(schema.integrations.id, integrationId))
      .limit(1);

    const shopId = integration?.platformAccountId;
    if (!shopId) {
      console.log(`[GrowthIngestion] No shopId for Etsy integration ${integrationId}`);
      return 0;
    }

    // Fetch recent sales
    const sales = await etsyService.getRecentSales(credentials.access_token, shopId);
    if (!Array.isArray(sales) || sales.length === 0) {
      return 0;
    }

    console.log(`[GrowthIngestion] Fetched ${sales.length} Etsy sales for user ${userId}`);

    // Transform and ingest
    const transactions = sales.map((sale: any) => ({
      amount: Math.round((sale.amount?.amount || 0) * 100), // Convert to cents
      currency: sale.amount?.currency_code || 'usd',
      id: sale.transaction_id?.toString() || sale.receipt_id?.toString() || `${uuidv4()}`,
      date: sale.creation_tsz ? new Date(sale.creation_tsz * 1000) : new Date(),
      customerEmail: sale.buyer?.email,
      productName: sale.title || sale.listing_title || 'Etsy Product',
    }));

    // Feed into Revenue Oracle — triggers milestone & thank-you email flow
    await revenueOracle.ingestFromPlatform(userId, 'etsy', transactions);

    return transactions.length;
  }

  /**
   * Ingests TikTok video engagement data for a user.
   * Fetches video analytics and records engagement metrics.
   */
  private async ingestTikTokEngagement(userId: string): Promise<number> {
    const credentials = await integrationService.getCredentials(userId, 'tiktok_display');
    if (!credentials || !credentials.accessToken) {
      console.log(`[GrowthIngestion] No TikTok credentials for user ${userId}`);
      return 0;
    }

    // Fetch video analytics
    const analytics = await tiktokService.getVideoAnalytics(userId);
    const videos = analytics?.data?.videos || analytics?.videos || [];
    if (!Array.isArray(videos) || videos.length === 0) {
      return 0;
    }

    console.log(`[GrowthIngestion] Fetched ${videos.length} TikTok videos for user ${userId}`);

    // Record engagement metrics for each video
    for (const video of videos) {
      try {
        const videoId = video.id || `tt_${uuidv4()}`;
        
        await db.insert(schema.engagementMetrics).values({
          id: uuidv4(),
          userId,
          platform: 'tiktok',
          externalMediaId: videoId,
          viewCount: video.view_count || 0,
          likeCount: video.like_count || 0,
          commentCount: video.comment_count || 0,
          shareCount: video.share_count || 0,
          date: new Date(),
          createdAt: new Date(),
        });
      } catch (err: any) {
        console.warn(`[GrowthIngestion] Failed to record TikTok metric: ${err.message}`);
      }
    }

    // Also feed TikTok engagement as transaction data for growth tracking
    const totalViews = videos.reduce((sum: number, v: any) => sum + (v.view_count || 0), 0);
    const transactions = [{
      amount: Math.round(totalViews * 0.001), // $0.001 per view proxy value
      currency: 'usd',
      id: `tt-batch-${Date.now()}`,
      date: new Date(),
    }];

    // Feed growth proxy into Revenue Oracle
    if (transactions[0].amount > 0) {
      await revenueOracle.ingestFromPlatform(userId, 'tiktok', transactions);
    }

    return videos.length;
  }
}

export const growthIngestionOrchestrator = new GrowthIngestionOrchestrator();