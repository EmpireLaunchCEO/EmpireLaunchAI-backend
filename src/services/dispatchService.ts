import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { creationDraftService } from './creationDraftService.js';
import { tiktokService } from './tiktokService.js';
import { etsyService } from './etsyService.js';
import { shopifyService } from './shopifyService.js';

const { dispatchLogs } = schema;

export class DispatchService {
  async dispatch(draftId: string, platform: string) {
    const [draft] = await db.select().from(schema.creationDrafts).where(eq(schema.creationDrafts.id, draftId)).limit(1);
    if (!draft) throw new Error('Draft not found');
    if (draft.status !== 'approved') throw new Error('Draft must be approved before dispatch');

    let externalId: string | undefined;
    let error: string | undefined;
    let status: 'success' | 'failed' = 'success';

    try {
      // Real or mock dispatch logic
      switch (platform.toLowerCase()) {
        case 'tiktok':
          // Mocking TikTok post for now as per instructions (Task 5: mock or real)
          console.log(`[DispatchService] Dispatching to TikTok: ${draft.title}`);
          externalId = `tt_${uuidv4().split('-')[0]}`;
          break;
        case 'etsy':
          console.log(`[DispatchService] Dispatching to Etsy: ${draft.title}`);
          externalId = `etsy_${uuidv4().split('-')[0]}`;
          break;
        case 'shopify':
          console.log(`[DispatchService] Dispatching to Shopify: ${draft.title}`);
          externalId = `sh_${uuidv4().split('-')[0]}`;
          break;
        default:
          console.log(`[DispatchService] Dispatching to ${platform} (MOCK): ${draft.title}`);
          externalId = `ext_${uuidv4().split('-')[0]}`;
      }
    } catch (e: any) {
      status = 'failed';
      error = e.message;
    }

    // Log the dispatch event
    await db.insert(dispatchLogs).values({
      id: uuidv4(),
      draftId,
      userId: draft.userId,
      platform,
      status,
      externalId,
      error,
      createdAt: new Date(),
    });

    if (status === 'success') {
      await creationDraftService.updateStatus(draftId, 'dispatched');
    }

    return { status, externalId, error };
  }

  async getDispatchLogs(draftId: string) {
    return db.select()
      .from(dispatchLogs)
      .where(eq(dispatchLogs.draftId, draftId));
  }
}

export const dispatchService = new DispatchService();
