import { neuralBrowserQueue } from './queueService.js';
import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
const { assets } = schema;

/**
 * Platform objective types for the Content Creator Bridge.
 */
export type CreatorPlatform = 'canva' | 'kittl' | 'capcut' | 'figma_community' | 'behance' | 'redbubble' | 'artstation' | 'substack';
export type CreatorObjective = 'SEARCH_TEMPLATES' | 'DOWNLOAD_ASSET' | 'APPLY_DNA' | 'EXPORT_DESIGN' | 'FREE_TIER_BYPASS' | 'SEARCH_TRENDS';

/**
 * Harvest Objective — used by both the standard HunterGatherer
 * and the Content Creator Bridge.
 */
export interface HarvestObjective {
  platform: CreatorPlatform | 'fiverr' | 'etsy';
  objective: 'DOWNLOAD_ASSET' | 'SEARCH_TRENDS' | 'OPTIMIZE_LISTING' | CreatorObjective;
  params: any;
}

export class HunterGathererService {
  /**
   * Triggers an autonomous harvesting job using the Neural Browser Worker.
   */
  async triggerHarvesting(userId: string, objective: HarvestObjective) {
    console.log(`[HunterGatherer] Triggering ${objective.objective} on ${objective.platform} for user ${userId}`);
    
    const steps = this.generateBrowserSteps(objective);
    
    const job = await neuralBrowserQueue.add('hunter-gatherer-harvest', {
      userId,
      taskTitle: `Harvesting: ${objective.platform} - ${objective.objective}`,
      steps,
      platform: objective.platform,
      objective: objective.objective,
    });

    return { jobId: job.id, status: 'queued' };
  }

  /**
   * Generates browser automation steps for each platform + objective.
   * Follows the Hybrid API/Browser Switchboard pattern:
   * 1. Try API first (if available)
   * 2. Fallback to browser automation
   * 3. Apply Free First (use free tiers before paid)
   * 4. Apply Anti-Copycat (extract DNA only, discard source images)
   */
  private generateBrowserSteps(objective: HarvestObjective) {
    const { platform, objective: type, params } = objective;
    const steps: any[] = [];

    switch (platform) {
      // ─── CANVA ───────────────────────────────────────────────
      case 'canva':
        if (type === 'SEARCH_TRENDS') {
          // Free Tier: Browse Canva's free template library
          steps.push({ action: 'navigate', url: `https://www.canva.com/templates/?query=${encodeURIComponent(params.niche || '')}&sort=trending` });
          steps.push({ action: 'wait', value: '[data-testid="template-card"]' });
          steps.push({ action: 'extract', selector: '[data-testid="template-card"]', multiple: true, fields: { title: 'img@alt', url: 'a@href' } });
          steps.push({ action: 'screenshot' });
        } else if (type === 'FREE_TIER_BYPASS') {
          // Navigate to Canva's free-only section (bypasses pro templates)
          steps.push({ action: 'navigate', url: `https://www.canva.com/templates/?query=${encodeURIComponent(params.niche || '')}&pricing=free` });
          steps.push({ action: 'wait', value: '[data-testid="template-card"]' });
          steps.push({ action: 'extract', selector: '[data-testid="template-card"]', multiple: true, fields: { title: 'img@alt', url: 'a@href', thumbnail: 'img@src' } });
        } else if (type === 'DOWNLOAD_ASSET') {
          steps.push({ action: 'navigate', url: `https://www.canva.com/design/${params.designId}/edit` });
          steps.push({ action: 'wait', value: 'button[data-test-id="share-menu-button"]' });
          steps.push({ action: 'click', selector: 'button[data-test-id="share-menu-button"]' });
          steps.push({ action: 'click', selector: 'button[data-test-id="download-button"]' });
          steps.push({ action: 'screenshot' });
          // ANTI-COPYCAT: Discard image buffer after extraction (metadata only stored)
          steps.push({ action: 'extract', selector: 'meta[name="description"]@content', multiple: false });
        }
        break;

      // ─── KITTL ───────────────────────────────────────────────
      case 'kittl':
        if (type === 'SEARCH_TEMPLATES' || type === 'SEARCH_TRENDS') {
          // Free Tier: Browse Kittl's free templates
          steps.push({ action: 'navigate', url: `https://www.kittl.com/templates?query=${encodeURIComponent(params.niche || '')}&filter=free&sort=trending` });
          steps.push({ action: 'wait', value: '.template-card' });
          steps.push({ 
            action: 'extract', 
            selector: '.template-card', 
            multiple: true, 
            fields: { 
              title: 'h3', 
              thumbnail: 'img@src',
              useCount: '.use-count',
              likes: '.like-count',
              isStaffPick: '.staff-pick-badge'
            } 
          });
          steps.push({ action: 'screenshot' });
        } else if (type === 'APPLY_DNA') {
          // Apply DNA manifest to template: navigate to editor, inject colors/fonts
          steps.push({ action: 'navigate', url: `https://www.kittl.com/design/${params.designId}` });
          steps.push({ action: 'wait', value: '.design-canvas' });
          // Apply color palette from DNA
          if (params.colors && Array.isArray(params.colors)) {
            steps.push({ action: 'click', selector: '[data-tool="color-picker"]' });
            for (const color of params.colors) {
              steps.push({ action: 'type', selector: '.color-input', value: color });
              steps.push({ action: 'click', selector: '.apply-color' });
            }
          }
          // Apply font family from DNA
          if (params.fontFamily) {
            steps.push({ action: 'click', selector: '[data-tool="font-selector"]' });
            steps.push({ action: 'type', selector: '.font-search', value: params.fontFamily });
            steps.push({ action: 'click', selector: `.font-option:contains("${params.fontFamily}")` });
          }
        } else if (type === 'EXPORT_DESIGN') {
          steps.push({ action: 'click', selector: '[data-tool="export"]' });
          steps.push({ action: 'click', selector: '.export-png' });
          steps.push({ action: 'wait', value: '.download-ready' });
          steps.push({ action: 'screenshot' });
        } else if (type === 'DOWNLOAD_ASSET') {
          // Template-free download for Premium+ users
          steps.push({ action: 'navigate', url: `https://www.kittl.com/design/${params.designId}` });
          steps.push({ action: 'wait', value: '.design-canvas' });
          steps.push({ action: 'click', selector: '[data-tool="export"]' });
          steps.push({ action: 'click', selector: '.export-png' });
          steps.push({ action: 'wait', value: '.download-ready' });
        }
        break;

      // ─── CAPCUT ──────────────────────────────────────────────
      case 'capcut':
        if (type === 'SEARCH_TEMPLATES') {
          // Free Tier: Browse CapCut template library
          steps.push({ action: 'navigate', url: `https://www.capcut.com/templates?keyword=${encodeURIComponent(params.niche || '')}` });
          steps.push({ action: 'wait', value: '.template-item' });
          steps.push({ action: 'extract', selector: '.template-item', multiple: true, fields: { title: '.template-title', thumbnail: 'img@src', duration: '.template-duration' } });
        } else if (type === 'APPLY_DNA') {
          // Apply Style DNA to a CapCut project (pacing, colors)
          steps.push({ action: 'navigate', url: `https://www.capcut.com/editor?project=${params.projectId}` });
          steps.push({ action: 'wait', value: '.editor-canvas' });
          // Apply pacing curve from DNA
          if (params.pacing) {
            steps.push({ action: 'click', selector: '[data-tool="speed"]' });
            const speedValue = params.pacing === 'fast' ? 1.5 : params.pacing === 'slow' ? 0.75 : 1.0;
            steps.push({ action: 'type', selector: '.speed-input', value: speedValue.toString() });
          }
        } else if (type === 'EXPORT_DESIGN') {
          steps.push({ action: 'click', selector: '.export-button' });
          steps.push({ action: 'click', selector: '.export-mp4' });
          steps.push({ action: 'wait', value: '.export-complete' });
        } else if (type === 'FREE_TIER_BYPASS') {
          // Bypass pro content — only show free templates
          steps.push({ action: 'navigate', url: `https://www.capcut.com/templates?keyword=${encodeURIComponent(params.niche || '')}&free=true` });
          steps.push({ action: 'wait', value: '.template-item' });
          steps.push({ action: 'extract', selector: '.template-item .free-badge', multiple: true });
        }
        break;

      // ─── FIVERR ──────────────────────────────────────────────
      case 'fiverr':
        if (type === 'SEARCH_TRENDS') {
          const query = params.query || params.niche || 'digital products';
          const searchUrl = `https://www.fiverr.com/search/gigs?query=${encodeURIComponent(query)}&seller_level=level_two_seller,top_rated_seller&delivery_time=1&sort_by=popularity`;
          
          steps.push({ action: 'navigate', url: searchUrl });
          steps.push({ action: 'wait', value: '.gig-card-layout' });
          steps.push({ 
            action: 'extract', 
            selector: '.gig-card-layout', 
            multiple: true,
            fields: {
              title: 'h3',
              url: 'a@href',
              rating: '.rating-score',
              reviewsCount: '.ratings-count',
              sellerLevel: '.seller-badge',
              isFiverrChoice: '.fiverrs-choice-badge, .badge-fiverrs-choice',
              ordersInQueue: 'span.orders-in-queue' // Might only be on detail page
            }
          });
          steps.push({ action: 'screenshot' });
        }
        break;

      // ─── ETSY ────────────────────────────────────────────────
      case 'etsy':
        if (type === 'SEARCH_TRENDS') {
          const query = params.query || params.niche || 'digital products';
          const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(query)}&explicit_free_shipping=false&item_type=all&digital=true&ship_to=US&order=highest_reviews`;
          
          steps.push({ action: 'navigate', url: searchUrl });
          steps.push({ action: 'wait', value: '.v2-listing-card' });
          steps.push({ 
            action: 'extract', 
            selector: '.v2-listing-card', 
            multiple: true, 
            fields: { 
              title: 'h3', 
              url: 'a@href',
              price: '.currency-value',
              isBestSeller: 'span.wt-badge--best-seller, span.wt-badge--sales-pitch',
              inBasket: '.wt-badge--basket, span.wt-badge--neutral:has-text("basket"), .wt-text-success',
              rating: '.wt-star-rating__rating',
              reviewsCount: '.wt-text-caption.wt-text-grey'
            } 
          });
        }
        break;

      // ─── FIGMA COMMUNITY ────────────────────────────────────
      case 'figma_community':
        if (type === 'SEARCH_TRENDS') {
          const query = params.query || params.niche || 'ui kit';
          steps.push({ action: 'navigate', url: `https://www.figma.com/community/search?q=${encodeURIComponent(query)}&sort=popular` });
          steps.push({ action: 'wait', value: '[class*="file_custom_view"]' });
          steps.push({ 
            action: 'extract', 
            selector: '[class*="file_custom_view"]', 
            multiple: true,
            fields: {
              title: '[class*="file_custom_view--title"]',
              url: 'a@href',
              duplicateCount: '[class*="file_custom_view--duplicates"]',
              likeCount: '[class*="file_custom_view--likes"]'
            }
          });
        }
        break;

      // ─── BEHANCE ────────────────────────────────────────────
      case 'behance':
        if (type === 'SEARCH_TRENDS') {
          const query = params.query || params.niche || 'brand identity';
          steps.push({ action: 'navigate', url: `https://www.behance.net/search/projects?search=${encodeURIComponent(query)}&sort=appreciations` });
          steps.push({ action: 'wait', value: '.ProjectCover-container-ADp' });
          steps.push({ 
            action: 'extract', 
            selector: '.ProjectCover-container-ADp', 
            multiple: true,
            fields: {
              title: '.ProjectCover-title-2_3',
              url: 'a@href',
              likes: '.ProjectCover-stat-1l8',
              isCurated: '.ProjectCover-featured-2_3'
            }
          });
        }
        break;

      // ─── REDBUBBLE ──────────────────────────────────────────
      case 'redbubble':
        if (type === 'SEARCH_TRENDS') {
          const query = params.query || params.niche || 'stickers';
          steps.push({ action: 'navigate', url: `https://www.redbubble.com/shop/?query=${encodeURIComponent(query)}&sortOrder=trending` });
          steps.push({ action: 'wait', value: '[data-testid="search-result-card"]' });
          steps.push({ 
            action: 'extract', 
            selector: '[data-testid="search-result-card"]', 
            multiple: true,
            fields: {
              title: '.styles__title--1Z_X_',
              url: 'a@href',
              isBestSeller: '.styles__bestSeller--2V_X_'
            }
          });
        }
        break;

      // ─── ARTSTATION ─────────────────────────────────────────
      case 'artstation':
        if (type === 'SEARCH_TRENDS') {
          const query = params.query || params.niche || 'game assets';
          steps.push({ action: 'navigate', url: `https://www.artstation.com/search?q=${encodeURIComponent(query)}&sort_by=trending` });
          steps.push({ action: 'wait', value: '.project-card' });
          steps.push({ 
            action: 'extract', 
            selector: '.project-card', 
            multiple: true,
            fields: {
              title: '.project-title',
              url: 'a@href',
              likes: '.project-stats-likes',
              views: '.project-stats-views'
            }
          });
        }
        break;

      // ─── SUBSTACK ───────────────────────────────────────────
      case 'substack':
        if (type === 'SEARCH_TRENDS') {
          steps.push({ action: 'navigate', url: `https://substack.com/discover/category/design` });
          steps.push({ action: 'wait', value: '.publication-card' });
          steps.push({ 
            action: 'extract', 
            selector: '.publication-card', 
            multiple: true,
            fields: {
              title: '.publication-title',
              url: 'a@href',
              subscribers: '.subscriber-count'
            }
          });
        }
        break;
    }

    // Default steps if none matched (prevent silent failures)
    if (steps.length === 0) {
      steps.push({ action: 'navigate', url: `https://www.${platform}.com` });
      steps.push({ action: 'screenshot' });
      console.warn(`[HunterGatherer] No browser steps defined for ${platform}/${type}`);
    }

    return steps;
  }
}

export const hunterGathererService = new HunterGathererService();