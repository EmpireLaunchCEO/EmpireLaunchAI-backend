import { neuralBrowserQueue } from './queueService.js';
import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
const { assets } = schema;

export interface HarvestObjective {
  platform: 'canva' | 'kittle' | 'capcut' | 'fiverr';
  objective: 'DOWNLOAD_ASSET' | 'SEARCH_TRENDS' | 'OPTIMIZE_LISTING';
  params: any;
}

export class HunterGathererService {
  /**
   * Triggers an autonomous harvesting job using the Neural Browser Worker.
   * This is the 'Free Tier Hunter-Gatherer' logic that bypasses API limitations.
   */
  async triggerHarvesting(userId: string, objective: HarvestObjective) {
    console.log(`[HunterGatherer] Triggering ${objective.objective} on ${objective.platform} for user ${userId}`);
    
    const steps = this.generateBrowserSteps(objective);
    
    const job = await neuralBrowserQueue.add('hunter-gatherer-harvest', {
      userId,
      taskTitle: `Harvesting: ${objective.platform} - ${objective.objective}`,
      steps
    });

    return { jobId: job.id, status: 'queued' };
  }

  private generateBrowserSteps(objective: HarvestObjective) {
    const { platform, objective: type, params } = objective;
    const steps: any[] = [];

    if (platform === 'canva') {
      if (type === 'DOWNLOAD_ASSET') {
        steps.push({ action: 'navigate', url: `https://www.canva.com/design/${params.designId}/edit` });
        steps.push({ action: 'wait', value: 'button[data-test-id="share-menu-button"]' });
        steps.push({ action: 'click', selector: 'button[data-test-id="share-menu-button"]' });
        steps.push({ action: 'click', selector: 'button[data-test-id="download-button"]' });
        // Add more steps as needed for the download flow
        steps.push({ action: 'screenshot' });
      }
    } else if (platform === 'fiverr') {
        if (type === 'SEARCH_TRENDS') {
            steps.push({ action: 'navigate', url: `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(params.query)}` });
            steps.push({ action: 'wait', value: '.gig-card-layout' });
            steps.push({ action: 'extract', selector: '.gig-card-layout h3' });
            steps.push({ action: 'screenshot' });
        }
    }

    // Default steps if none matched
    if (steps.length === 0) {
        steps.push({ action: 'navigate', url: `https://www.${platform}.com` });
        steps.push({ action: 'screenshot' });
    }

    return steps;
  }
}

export const hunterGathererService = new HunterGathererService();
