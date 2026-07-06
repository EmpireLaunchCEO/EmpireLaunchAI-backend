import { canvaDnaService } from './canvaDnaService.js';

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

  private async runHarvest(): Promise<void> {
    const now = Date.now();
    if (this.lastRun && (now - this.lastRun) < WEEK_MS) return;
    console.log('[Scheduler] Weekly Canva public template DNA harvest triggered');
    try {
      await canvaDnaService.performDeepExtraction('system');
      this.lastRun = now;
      console.log('[Scheduler] Weekly DNA harvest completed');
    } catch (err: any) {
      console.error('[Scheduler] Harvest failed:', err.message);
    }
  }
}

export const schedulerService = new SchedulerService();