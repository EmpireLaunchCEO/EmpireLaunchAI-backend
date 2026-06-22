import { db, schema } from '../db/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const { creationDrafts, creationFeedback, dispatchLogs } = schema;

export class CreationDraftService {
  async saveDraft(data: {
    userId: string;
    campaignId?: string;
    creationType: string;
    title: string;
    content: any;
    platform?: string;
    metadata?: any;
    rootId?: string;
  }) {
    const id = uuidv4();
    await db.insert(creationDrafts).values({
      id,
      ...data,
      rootId: data.rootId || id,
      version: data.rootId ? undefined : 1, // Drizzle will use default if undefined, but we need to handle versioning logic
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async createNewVersion(draftId: string, content: any, feedback?: string) {
    const [existing] = await db.select().from(creationDrafts).where(eq(creationDrafts.id, draftId)).limit(1);
    if (!existing) throw new Error('Draft not found');

    const newId = uuidv4();
    await db.insert(creationDrafts).values({
      id: newId,
      userId: existing.userId,
      campaignId: existing.campaignId,
      creationType: existing.creationType,
      title: existing.title,
      content,
      rootId: existing.rootId || existing.id,
      version: existing.version + 1,
      status: 'pending',
      platform: existing.platform,
      metadata: existing.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    if (feedback) {
      await this.addFeedback(newId, existing.userId, feedback, 'user');
    }

    return newId;
  }

  async addFeedback(draftId: string, userId: string, feedback: string, actor: 'user' | 'ai') {
    await db.insert(creationFeedback).values({
      id: uuidv4(),
      draftId,
      userId,
      feedback,
      actor,
      createdAt: new Date(),
    });
  }

  async updateStatus(draftId: string, status: 'approved' | 'rejected' | 'dispatched') {
    await db.update(creationDrafts)
      .set({ status, updatedAt: new Date() })
      .where(eq(creationDrafts.id, draftId));
  }

  async getDraftHistory(rootId: string) {
    return db.select()
      .from(creationDrafts)
      .where(eq(creationDrafts.rootId, rootId))
      .orderBy(desc(creationDrafts.version));
  }

  async getFeedbackHistory(draftId: string) {
    return db.select()
      .from(creationFeedback)
      .where(eq(creationFeedback.draftId, draftId))
      .orderBy(desc(creationFeedback.createdAt));
  }

  async getLatestDrafts(userId: string) {
      // Get the latest version for each rootId
      // This is a bit complex with Drizzle/SQLite without window functions in a simple way
      // For now, let's just return all drafts ordered by date
      return db.select()
        .from(creationDrafts)
        .where(eq(creationDrafts.userId, userId))
        .orderBy(desc(creationDrafts.createdAt));
  }
}

export const creationDraftService = new CreationDraftService();
