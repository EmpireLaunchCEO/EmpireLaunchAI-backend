import { Worker, Job } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { metaService } from '../services/metaService.js';
import { tiktokService } from '../services/tiktokService.js';
import { youtubeService } from '../services/youtubeService.js';
import { hunterGathererService } from '../services/hunterGathererService.js';
import { webSocketService } from '../services/websocketService.js';
import { notificationService } from '../services/notificationService.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
const { scheduledPosts } = schema;

export const startDistributionWorker = () => {
  const worker = new Worker(
    'distribution-tasks',
    async (job: Job) => {
      const { postId, userId, platform, content, requiresBrowser, browserSequenceHint } = job.data;
      console.log(`[DistributionWorker] Processing job ${job.id} for user ${userId}: ${platform}`);

      // Notify user via WebSocket
      webSocketService.notifyUser(userId, 'distribution-started', { jobId: job.id, platform, postId });

      // Extract caption from content (supports both flat and content-object formats)
      const caption = content.caption || content.content?.caption || '';
      const videoUrl = content.videoUrl || content.content?.videoUrl;
      const imageUrl = content.imageUrl || content.content?.imageUrl;
      const title = content.title || content.content?.title || 'Empire Post';

      try {
        let result: any;

        try {
            if (platform === 'instagram' || platform === 'facebook') {
                result = await metaService.publishPost(userId, { ...content, caption, imageUrl });
            } else if (platform === 'tiktok') {
                result = await tiktokService.publishVideo(
                    userId, 
                    videoUrl, 
                    title,
                    caption
                );
            } else if (platform === 'youtube' || platform === 'youtube_shorts') {
                result = await youtubeService.publishShorts(
                    userId, 
                    videoUrl, 
                    title,
                    caption
                );
            } else if (platform === 'etsy' || platform === 'fiverr' || platform === 'shopify') {
                // Route Marketplace listings through the ListingEngine or Hunter-Gatherer
                console.log(`[DistributionWorker] Routing ${platform} to neural browser...`);
                throw new Error(`API distribution restricted for ${platform}. Triggering Browser Agent.`);
            } else {
                throw new Error(`Platform ${platform} not supported for distribution`);
            }
        } catch (apiError: any) {
            console.warn(`[DistributionWorker] API Distribution failed for ${platform}: ${apiError.message}. Triggering Free Tier Hunter-Gatherer fallback...`);
            
            webSocketService.notifyUser(userId, 'ai-log', { 
                message: `[SYSTEM] API distribution restricted for ${platform}. Initiating Neural Browser Distribution (Hunter-Gatherer)...` 
            });

            // If browserSequenceHint was provided (from Empire Studio), pass it through
            const harvestingResult = await hunterGathererService.triggerHarvesting(userId, {
                platform: platform.toLowerCase() as any,
                objective: 'OPTIMIZE_LISTING',
                params: { ...content, postId, browserSequenceHint }
            });

            return { status: 'pivoted_to_browser', jobId: harvestingResult.jobId };
        }

        // Update post status in DB
        await db.update(scheduledPosts)
          .set({ status: 'posted', updatedAt: new Date() })
          .where(eq(scheduledPosts.id, postId));

        webSocketService.notifyUser(userId, 'distribution-completed', {
          jobId: job.id,
          status: 'success',
          platform,
          postId
        });

        await notificationService.notifyUser(userId, `Your post to ${platform} has been published successfully!`, false);

        return { status: 'success', result };
      } catch (error: any) {
        console.error(`[DistributionWorker] Error processing job ${job.id}:`, error);

        // Update post status to failed in DB
        await db.update(scheduledPosts)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(scheduledPosts.id, postId));

        webSocketService.notifyUser(userId, 'distribution-failed', {
          jobId: job.id,
          error: error.message,
          platform,
          postId
        });

        await notificationService.notifyUser(userId, `Failed to publish your post to ${platform}: ${error.message}`, true);

        throw error;
      }
    },
    {
      connection: redisConnection,
      concurrency: 5,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[DistributionWorker] Job ${job.id} has completed!`);
  });

  worker.on('failed', (job, err) => {
    console.log(`[DistributionWorker] Job ${job?.id} has failed with ${err.message}`);
  });

  return worker;
};
