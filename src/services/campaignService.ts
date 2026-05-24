import { db, schema } from '../db/index.js';
const { campaigns, scheduledPosts, approvals } = schema;
import { eq, and, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { notificationService } from './notificationService.js';
import { metaService } from './metaService.js';
import { tiktokService } from './tiktokService.js';

export class CampaignService {
  async createCampaign(userId: string, data: { name: string; tone: string; frequency: string; goalId?: string }) {
    const id = uuidv4();
    const [campaign] = await db.insert(campaigns).values({
      id,
      userId,
      goalId: data.goalId,
      name: data.name,
      tone: data.tone,
      frequency: data.frequency,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();
    return campaign;
  }

  async schedulePost(userId: string, campaignId: string, platform: string, content: any, scheduledFor: Date) {
    const postId = uuidv4();
    const approvalId = uuidv4();

    // 1. Create Approval Request
    await db.insert(approvals).values({
      id: approvalId,
      userId,
      type: 'content',
      payload: {
        postId,
        platform,
        content,
        scheduledFor
      },
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 2. Create Scheduled Post (linked to approval)
    const [post] = await db.insert(scheduledPosts).values({
      id: postId,
      campaignId,
      platform,
      content,
      scheduledFor,
      status: 'pending',
      approvalId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    // 3. Notify User
    await notificationService.notifyUser(
      userId,
      `A new post for ${platform} has been scheduled for ${scheduledFor.toLocaleString()}. Please view and approve it.`,
      true
    );

    return post;
  }

  async approvePost(userId: string, postId: string) {
    const [post] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, postId)).limit(1);
    if (!post) throw new Error('Post not found');

    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, post.campaignId)).limit(1);
    if (campaign.userId !== userId) throw new Error('Unauthorized');

    // Update approval status
    if (post.approvalId) {
      await db.update(approvals)
        .set({ status: 'approved', updatedAt: new Date() })
        .where(eq(approvals.id, post.approvalId));
    }

    // Update post status
    await db.update(scheduledPosts)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(scheduledPosts.id, postId));

    return { success: true };
  }

  async reschedulePost(postId: string, newDate: Date) {
    const [post] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, postId)).limit(1);
    if (!post) throw new Error('Post not found');

    await db.update(scheduledPosts)
      .set({ scheduledFor: newDate, updatedAt: new Date() })
      .where(eq(scheduledPosts.id, postId));

    return { success: true, newDate };
  }

  async processDuePosts() {
    return this.executeApprovedPosts();
  }

  async executeApprovedPosts() {
    const now = new Date();
    const pendingPosts = await db.select()
      .from(scheduledPosts)
      .where(and(
        eq(scheduledPosts.status, 'approved'),
        sql`${scheduledPosts.scheduledFor} <= ${now}`
      ));

    console.log(`Executing ${pendingPosts.length} approved posts...`);

    for (const post of pendingPosts) {
      try {
        const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, post.campaignId)).limit(1);
        const userId = campaign.userId;

        if (post.platform === 'instagram' || post.platform === 'facebook') {
          await metaService.publishPost(userId, post.content);
        } else if (post.platform === 'tiktok') {
          // Assuming tiktokService.publishPost exists or will be implemented
          // await tiktokService.publishPost(userId, post.content);
          console.log(`[TikTok] Posting for user ${userId}... (Simulation)`);
        }

        await db.update(scheduledPosts)
          .set({ status: 'posted', updatedAt: new Date() })
          .where(eq(scheduledPosts.id, post.id));
        
        await notificationService.notifyUser(userId, `Your post to ${post.platform} has been published successfully!`);
      } catch (error: any) {
        console.error(`Failed to execute post ${post.id}:`, error.message);
        await db.update(scheduledPosts)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(eq(scheduledPosts.id, post.id));
        
        // Notify user about failure
        const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, post.campaignId)).limit(1);
        await notificationService.notifyUser(campaign.userId, `Failed to publish your post to ${post.platform}: ${error.message}`);
      }
    }
  }
}

export const campaignService = new CampaignService();
