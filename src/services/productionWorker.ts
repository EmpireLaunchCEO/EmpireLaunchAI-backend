import { v4 as uuidv4 } from 'uuid';
import { contentCreatorBridge, CreatorPlatform } from './contentCreatorBridge.js';
import { getRouter, ExecutionResult } from './platformRouter.js';
import { notificationService } from './notificationService.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProductionJob {
  jobId: string;
  type: 'CREATE_CONTENT' | 'SCHEDULE_POST' | 'DRAFT_LISTING';
  userId: string;
  params: Record<string, any>;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface ProductionResult {
  jobId: string;
  success: boolean;
  data?: any;
  error?: string;
}

// ─── Production Worker ──────────────────────────────────────────────────────

export class ProductionWorker {
  private jobQueue: ProductionJob[] = [];
  private isProcessing: boolean = false;
  private maxConcurrent: number = 2;

  /**
   * Queue a CREATE_CONTENT job — uses ContentCreatorBridge for design generation.
   * Respects Zero-Source-Image and Free-First protocols (built into the bridge).
   */
  queueContentCreation(userId: string, params: { platform?: string; niche?: string; taskId?: string; styleDna?: any }): ProductionJob {
    const job: ProductionJob = {
      jobId: uuidv4(),
      type: 'CREATE_CONTENT',
      userId,
      params,
      status: 'queued',
      createdAt: new Date(),
    };
    this.jobQueue.push(job);
    console.log(`[ProductionWorker] Queued CREATE_CONTENT job ${job.jobId} for user ${userId}`);
    this.processQueue();
    return job;
  }

  /**
   * Queue a SCHEDULE_POST job — uses PlatformRouter for distribution.
   */
  queueSchedulePost(userId: string, params: { platforms?: string[]; assetId?: string }): ProductionJob {
    const job: ProductionJob = {
      jobId: uuidv4(),
      type: 'SCHEDULE_POST',
      userId,
      params,
      status: 'queued',
      createdAt: new Date(),
    };
    this.jobQueue.push(job);
    console.log(`[ProductionWorker] Queued SCHEDULE_POST job ${job.jobId} for user ${userId}`);
    this.processQueue();
    return job;
  }

  /**
   * Queue a DRAFT_LISTING job — uses PlatformRouter for listing creation.
   */
  queueDraftListing(userId: string, params: { platform?: string; productName?: string }): ProductionJob {
    const job: ProductionJob = {
      jobId: uuidv4(),
      type: 'DRAFT_LISTING',
      userId,
      params,
      status: 'queued',
      createdAt: new Date(),
    };
    this.jobQueue.push(job);
    console.log(`[ProductionWorker] Queued DRAFT_LISTING job ${job.jobId} for user ${userId}`);
    this.processQueue();
    return job;
  }

  /**
   * Get job status.
   */
  getJobStatus(jobId: string): ProductionJob | undefined {
    return this.jobQueue.find(j => j.jobId === jobId);
  }

  /**
   * Get all jobs for a user.
   */
  getJobsForUser(userId: string): ProductionJob[] {
    return this.jobQueue.filter(j => j.userId === userId);
  }

  /**
   * Process the job queue asynchronously.
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.jobQueue.some(j => j.status === 'queued')) {
      const activeCount = this.jobQueue.filter(j => j.status === 'processing').length;
      if (activeCount >= this.maxConcurrent) {
        await this.sleep(1000);
        continue;
      }

      const job = this.jobQueue.find(j => j.status === 'queued');
      if (!job) break;

      job.status = 'processing';
      this.executeJob(job).catch(err => {
        job.status = 'failed';
        job.error = err.message;
        job.completedAt = new Date();
        console.error(`[ProductionWorker] Job ${job.jobId} failed:`, err.message);
      });
    }

    this.isProcessing = false;
  }

  /**
   * Execute a single production job.
   */
  private async executeJob(job: ProductionJob): Promise<void> {
    console.log(`[ProductionWorker] Executing ${job.type} job ${job.jobId}`);

    try {
      let result: ExecutionResult;

      switch (job.type) {
        case 'CREATE_CONTENT': {
          const platform = (job.params.platform || 'canva') as CreatorPlatform;
          const niche = job.params.niche || 'digital product';

          // ContentCreatorBridge handles Free-First and Zero-Source-Image internally
          const bridgeResult = await contentCreatorBridge.executeDesignFlow(
            job.userId,
            platform,
            niche,
            job.params.styleDna
          );

          result = {
            success: true,
            data: { bridgeResult, platform, niche },
            externalId: bridgeResult?.designId || bridgeResult?.vaultStrandId,
          };

          // Notify the user
          await notificationService.sendNotification(job.userId, {
            type: 'CONTENT_CREATED',
            title: `🎨 ${platform} design created`,
            message: `AI designed a "${niche}" asset on ${platform}`,
            metadata: { platform, niche, designId: bridgeResult?.designId },
          });
          break;
        }

        case 'SCHEDULE_POST': {
          const router = getRouter();
          result = await router.route({
            type: 'SCHEDULE_POST',
            platforms: job.params.platforms || ['tiktok', 'instagram'],
            assetId: job.params.assetId,
            userId: job.userId,
          });

          // Notify the user about scheduled posts
          await notificationService.sendNotification(job.userId, {
            type: 'POST_SCHEDULED',
            title: '📅 Posts scheduled',
            message: `Content scheduled on ${(job.params.platforms || ['tiktok']).join(', ')}`,
            metadata: { platforms: job.params.platforms },
          });
          break;
        }

        case 'DRAFT_LISTING': {
          const router = getRouter();
          result = await router.route({
            type: 'DRAFT_LISTING',
            platform: job.params.platform || 'etsy',
            productName: job.params.productName || 'AI-Generated Product',
            userId: job.userId,
          });

          await notificationService.sendNotification(job.userId, {
            type: 'LISTING_DRAFTED',
            title: '📦 Listing drafted',
            message: `Draft listing created on ${job.params.platform || 'etsy'}`,
            metadata: { platform: job.params.platform },
          });
          break;
        }

        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }

      job.status = 'completed';
      job.result = result;
      job.completedAt = new Date();
      console.log(`[ProductionWorker] Job ${job.jobId} completed successfully`);
    } catch (error: any) {
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date();
      console.error(`[ProductionWorker] Job ${job.jobId} failed:`, error.message);
    }
  }

  /**
   * Process decisions from the GoalExecutionEngine's tick.
   * Called by the scheduler worker after each engine tick.
   */
  processDecision(decision: { type: string; [key: string]: any }, userId: string = 'system'): ProductionJob | null {
    switch (decision.type) {
      case 'CREATE_CONTENT':
        return this.queueContentCreation(userId, {
          platform: decision.platform,
          taskId: decision.taskId,
          niche: decision.niche,
        });

      case 'SCHEDULE_POST':
        return this.queueSchedulePost(userId, {
          platforms: decision.platforms,
          assetId: decision.assetId,
        });

      case 'DRAFT_LISTING':
        return this.queueDraftListing(userId, {
          platform: decision.platform,
          productName: decision.productName,
        });

      default:
        return null; // Not a producible decision
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: ProductionWorker | null = null;

export function getProductionWorker(): ProductionWorker {
  if (!_instance) _instance = new ProductionWorker();
  return _instance;
}
