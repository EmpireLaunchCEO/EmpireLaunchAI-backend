import { db, schema } from '../db/index.js';
const { reviews, scheduledPosts, campaigns } = schema;
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { appendNotification } from './feedbackNotifier.js';

export class ReviewService {
  async submitReview(userId: string, rating: number, comment?: string) {
    const id = uuidv4();
    // 4 or 5 stars are flagged for marketing
    const flaggedForMarketing = rating >= 4;
    
    // Fetch user info for identification
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    const userEmail = user?.email || 'stacipeabody@gmail.com'; // Default to owner for demo/mock users

    console.log(`[Feedback] from ${userEmail} (${userId}): ${rating} stars. Message: "${comment}"`);

    // @ts-ignore
    const [review] = await db.insert(reviews).values({
      id,
      userId,
      rating,
      comment,
      flaggedForMarketing,
      marketingApproved: false,
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();

    // Write notification for the team lead to email the owner
    appendNotification({ ...review, userEmail });

    return review;
  }

  async getFlaggedReviews(userId: string) {
    console.log(`Fetching flagged reviews for user ${userId}`);
    // @ts-ignore
    return await db.select()
      .from(reviews)
      .where(and(
        eq(reviews.userId, userId),
        eq(reviews.flaggedForMarketing, true),
        eq(reviews.marketingApproved, false)
      ))
      .orderBy(desc(reviews.createdAt));
  }

  async approveReviewForMarketing(userId: string, reviewId: string) {
    console.log(`Approving review ${reviewId} for marketing by user ${userId}`);
    // @ts-ignore
    const [review] = await db.update(reviews)
      .set({ marketingApproved: true, updatedAt: new Date() })
      .where(and(eq(reviews.id, reviewId), eq(reviews.userId, userId)))
      .returning();

    if (review) {
      // Trigger post creation/queuing
      await this.queueSocialProofPost(userId, review);
    }

    return review;
  }

  private async queueSocialProofPost(userId: string, review: any) {
    console.log(`Queuing social proof post for review ${review.id}`);
    
    // Find an active campaign for the user or create a default one
    // @ts-ignore
    let [campaign] = await db.select().from(campaigns).where(eq(campaigns.userId, userId)).limit(1);
    
    if (!campaign) {
      console.log(`No campaign found for user ${userId}, creating default 'Social Proof' campaign.`);
      const campaignId = uuidv4();
      // @ts-ignore
      [campaign] = await db.insert(campaigns).values({
        id: campaignId,
        userId,
        name: 'Social Proof Campaign',
        tone: 'playful',
        frequency: 'daily',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      }).returning();
    }

    const postId = uuidv4();
    const caption = `Another ${review.rating}-star review! ⭐\n\n"${review.comment || 'We love our customers!'}" #EmpireLaunch #SocialProof`;
    
    // In a real scenario, we might want a generated image or a template.
    // For now, using a high-quality relevant placeholder.
    const imageUrl = "https://images.unsplash.com/photo-1557200134-90327ee9fafa?q=80&w=1000&auto=format&fit=crop";

    // @ts-ignore
    await db.insert(scheduledPosts).values({
      id: postId,
      campaignId: campaign.id,
      platform: 'instagram',
      content: {
        caption,
        imageUrl,
      },
      scheduledFor: new Date(), // Immediate posting for this loop
      status: 'approved', // Directly approved as the user just clicked "Approve for Marketing"
      createdAt: new Date(),
      updatedAt: new Date()
    });

    console.log(`Social proof post ${postId} queued successfully.`);
  }

  async getTrustMetrics(userId: string) {
    // @ts-ignore
    const allReviews = await db.select().from(reviews).where(eq(reviews.userId, userId));
    
    const total = allReviews.length;
    if (total === 0) return { score: 85, velocity: 80, sentiment: 80, agility: 90 };

    const avgRating = allReviews.reduce((sum: number, r: any) => sum + r.rating, 0) / total;
    const sentiment = Math.round((avgRating / 5) * 100);
    
    // Mock velocity and agility for now, but derived from actual count
    const velocity = Math.min(100, 70 + (total * 2));
    const agility = 94; // System response time constant

    return {
      score: Math.round((sentiment * 0.6) + (velocity * 0.4)),
      sentiment,
      velocity,
      agility
    };
  }

  async getSentimentMap(userId: string) {
    // @ts-ignore
    const allReviews = await db.select().from(reviews)
      .where(eq(reviews.userId, userId))
      .orderBy(desc(reviews.createdAt))
      .limit(7);

    return allReviews.map((r: any) => ({
      score: r.rating * 20,
      date: r.createdAt,
      label: r.rating >= 4 ? 'Positive' : 'Neutral'
    })).reverse();
  }
}

export const reviewService = new ReviewService();
