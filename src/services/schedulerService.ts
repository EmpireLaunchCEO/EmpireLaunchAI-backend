import { canvaDnaService } from './canvaDnaService.js';
import { canvaDnaHarvesterService } from './canvaDnaHarvesterService.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_MS = 30 * 60 * 1000;

export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRun: number | null = null;

  start(): void {
    if (this.timer) return;
    console.log('[Scheduler] Starting weekly DNA harvest scheduler...');
    setTimeout(() => this.runHarvest(), 30000);
    this.timer = setInterval(() => this.runHarvest(), CHECK_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Find a user ID that has an active Canva integration.
   * Falls back to the owner account (00000000-...).
   */
  private async findCanvaUser(): Promise<string | null> {
    try {
      const rows = await db.select()
        .from(schema.integrations)
        .where(eq(schema.integrations.platform, 'canva'))
        .limit(1);
      if (rows.length > 0 && rows[0].credentials) {
        return rows[0].userId;
      }
    } catch (err: any) {
      console.warn('[Scheduler] Could not query Canva integrations:', err.message);
    }
    return null;
  }

  private async runHarvest(): Promise<void> {
    const now = Date.now();
    if (this.lastRun && (now - this.lastRun) < WEEK_MS) return;
    console.log('[Scheduler] Weekly Canva DNA harvest triggered');

    const canvaUserId = await this.findCanvaUser();
    if (!canvaUserId) {
      console.warn('[Scheduler] No Canva integration found — skipping harvest. Link Canva via Neural Link Center.');
      return;
    }

    try {
      // 1. Personal Brand Kit + Design DNA via Canva API
      await canvaDnaService.performDeepExtraction(canvaUserId);
      console.log('[Scheduler] Personal DNA extraction completed');
    } catch (err: any) {
      console.error('[Scheduler] Personal DNA extraction failed:', err.message);
    }

    try {
      // 2. Gallery template DNA (public + Pro) via Playwright-based harvester
      console.log(`[Scheduler] Starting Canva Gallery template DNA harvest for user ${canvaUserId}...`);
      const result = await canvaDnaHarvesterService.harvestForUser(canvaUserId);
      console.log(`[Scheduler] Gallery harvest: ${result.totalStrands} strands from ${result.categoriesHarvested} categories`);
    } catch (err: any) {
      console.error('[Scheduler] Gallery harvest failed:', err.message);
    }

    this.lastRun = now;
    console.log('[Scheduler] Weekly DNA harvest cycle completed');
  }
}

export const schedulerService = new SchedulerService();