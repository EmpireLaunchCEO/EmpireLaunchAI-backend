import { db, schema } from '../db/index.js';
const { marketSignals, integrations, users } = schema;
import { eq, and, desc, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { marketIntelligenceService } from './marketIntelligenceService.js';
import { neuralMarketDiscoveryService } from './neuralMarketDiscoveryService.js';
import { approvalService } from './approvalService.js';
import { etsyService } from './etsyService.js';

export interface MarketResearchResult {
  signalsFound: number;
  highConfidenceSignals: number;
  approvalGatesTriggered: string[];
  errors: string[];
}

/**
 * AutonomousMarketResearcher — a background service that periodically polls
 * Etsy, TikTok, and YouTube for trending data, extracts market signals,
 * and saves them to the `market_signals` table.
 *
 * High-confidence signals are automatically escalated through the
 * Human-in-the-Loop approval gate for strategy suggestions.
 */
export class AutonomousMarketResearcher {

  /**
   * Run a full market research cycle across all niches and platforms.
   * Called periodically (e.g., every 3 hours) from the scheduler worker.
   */
  async runResearchCycle(userId?: string): Promise<MarketResearchResult> {
    const result: MarketResearchResult = {
      signalsFound: 0,
      highConfidenceSignals: 0,
      approvalGatesTriggered: [],
      errors: [],
    };

    try {
      // Get all active users (or a specific user)
      const targetUsers = userId
        ? [{ id: userId }]
        : await db.select({ id: users.id }).from(users).limit(10);

      for (const user of targetUsers) {
        try {
          // Get the user's niches from their integrations/context
          const niches = await this.getNichesForUser(user.id);
          if (niches.length === 0) continue;

          for (const niche of niches) {
            try {
              const cycleResult = await this.researchNiche(user.id, niche);
              result.signalsFound += cycleResult.signalsCreated;
              result.highConfidenceSignals += cycleResult.highConfidenceCount;
              result.approvalGatesTriggered.push(...cycleResult.approvalIds);
            } catch (err: any) {
              result.errors.push(`Niche "${niche}": ${err.message}`);
            }
          }
        } catch (err: any) {
          result.errors.push(`User ${user.id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      result.errors.push(`Research cycle: ${err.message}`);
    }

    return result;
  }

  /**
   * Research a specific niche across all platforms.
   */
  async researchNiche(userId: string, niche: string): Promise<{
    signalsCreated: number;
    highConfidenceCount: number;
    approvalIds: string[];
  }> {
    const output = { signalsCreated: 0, highConfidenceCount: 0, approvalIds: [] as string[] };
    const now = new Date();

    // ── 1. Etsy: Top sellers & keywords ──
    try {
      const etsyListings = await marketIntelligenceService.fetchEtsyBestSellers(niche, userId);
      if (etsyListings && etsyListings.length > 0) {
        for (const listing of etsyListings.slice(0, 5)) {
          // Heat Signal logic: 10+ in basket = high velocity
          const hasHighHeat = listing.signals?.inBasket?.includes('10+') || listing.isBestSeller;
          const confidence = hasHighHeat ? 0.95 : 0.75;
          
          await this.saveSignal({
            niche,
            platform: 'etsy',
            signalType: 'trend',
            title: `Etsy High-Velocity: ${listing.title}`,
            description: `Heat Signal: ${listing.signals?.inBasket || 'Best Seller'}. URL: ${listing.url || 'N/A'}`,
            confidence,
            actionable: true,
          });
          output.signalsCreated++;
          if (confidence > 0.9) output.highConfidenceCount++;
        }
      }
    } catch (err: any) {
      console.error(`[MarketResearch] Etsy research error for "${niche}":`, err.message);
    }

    // ── 1b. New Platforms: Figma, Kittl, Behance, Redbubble, ArtStation, Substack ──
    const platformTasks = [
      { name: 'figma_community', fetch: () => marketIntelligenceService.fetchFigmaCommunityTrends(niche, userId) },
      { name: 'kittl', fetch: () => marketIntelligenceService.fetchKittlTrends(niche, userId) },
      { name: 'behance', fetch: () => marketIntelligenceService.fetchBehanceTrends(niche, userId) },
      { name: 'redbubble', fetch: () => marketIntelligenceService.fetchRedbubbleTrends(niche, userId) },
      { name: 'artstation', fetch: () => marketIntelligenceService.fetchArtStationTrends(niche, userId) },
      { name: 'substack', fetch: () => marketIntelligenceService.fetchSubstackTrends(niche, userId) }
    ];

    for (const pTask of platformTasks) {
      try {
        const platformListings = await pTask.fetch();
        if (platformListings && platformListings.length > 0) {
          for (const listing of platformListings.slice(0, 3)) {
            let isHighConfidence = false;
            let signalDesc = `Detected trend on ${pTask.name}`;

            // Threshold checks based on Research Task 5 report
            if (pTask.name === 'figma_community') {
              if ((listing.signals?.duplicates || 0) > 1000 || (listing.signals?.likes || 0) > 300) isHighConfidence = true;
              signalDesc = `Duplicates: ${listing.signals?.duplicates}, Likes: ${listing.signals?.likes}`;
            } else if (pTask.name === 'kittl') {
              if ((listing.signals?.duplicates || 0) > 500 || listing.signals?.isStaffPick) isHighConfidence = true;
              signalDesc = `Uses: ${listing.signals?.duplicates}, Staff Pick: ${listing.signals?.isStaffPick}`;
            } else if (pTask.name === 'behance') {
              if (listing.signals?.isCurated && (listing.signals?.likes || 0) > 1500) isHighConfidence = true;
              signalDesc = `Likes: ${listing.signals?.likes}, Curated: ${listing.signals?.isCurated}`;
            } else if (pTask.name === 'redbubble') {
              if (listing.isBestSeller) isHighConfidence = true;
              signalDesc = `Best Seller Badge Detected`;
            } else if (pTask.name === 'artstation') {
              if ((listing.signals?.likes || 0) > 250 && (listing.signals?.views || 0) > 2000) isHighConfidence = true;
              signalDesc = `Likes: ${listing.signals?.likes}, Views: ${listing.signals?.views}`;
            } else if (pTask.name === 'substack') {
              if (listing.signals?.subscribers?.includes('thousands')) isHighConfidence = true;
              signalDesc = `Subscriber Tier: ${listing.signals?.subscribers}`;
            }

            const confidence = isHighConfidence ? 0.92 : 0.7;
            await this.saveSignal({
              niche,
              platform: pTask.name,
              signalType: 'trend',
              title: `${pTask.name.replace('_', ' ').toUpperCase()} Viral: ${listing.title}`,
              description: `${signalDesc}. URL: ${listing.url || 'N/A'}`,
              confidence,
              actionable: true,
            });
            output.signalsCreated++;
            if (isHighConfidence) output.highConfidenceCount++;
          }
        }
      } catch (err: any) {
        console.error(`[MarketResearch] ${pTask.name} research error for "${niche}":`, err.message);
      }
    }

    // ── 2. Neural Discovery: Niche DNA ──
    try {
      const nicheDna = await neuralMarketDiscoveryService.discoverNicheDna(niche);
      if (nicheDna && nicheDna.dnaElements && nicheDna.dnaElements.length > 0) {
        await this.saveSignal({
          niche,
          platform: 'neural_discovery',
          signalType: 'trend',
          title: `Niche DNA discovered: ${nicheDna.dnaElements.slice(0, 3).join(', ')}`,
          description: `AI-discovered DNA elements for "${niche}"`,
          confidence: 0.85,
          actionable: true,
        });
        output.signalsCreated++;
        output.highConfidenceCount++;
      }
    } catch (err: any) {
      console.error(`[MarketResearch] Neural discovery error for "${niche}":`, err.message);
    }

    // ── 3. Visual Trends ──
    try {
      const visualTrends = await marketIntelligenceService.fetchVisualTrends(niche);
      if (visualTrends && visualTrends.length > 0) {
        const topTrends = visualTrends.slice(0, 2);
        for (const trend of topTrends) {
          await this.saveSignal({
            niche,
            platform: 'visual_trends',
            signalType: 'viral_format',
            title: trend.title || `Visual trend in "${niche}"`,
            description: trend.description || 'AI-detected visual trend',
            confidence: 0.7,
            actionable: true,
          });
          output.signalsCreated++;
        }
      }
    } catch (err: any) {
      console.error(`[MarketResearch] Visual trends error for "${niche}":`, err.message);
    }

    // ── 4. High-confidence signals → trigger approval gate ──
    if (output.highConfidenceCount > 0) {
      try {
        const approval = await approvalService.createRequest(
          userId,
          'content',
          `New market opportunity detected in "${niche}" — AI recommends strategy pivot`,
          {
            niche,
            signalsFound: output.signalsCreated,
            highConfidenceSignals: output.highConfidenceCount,
            source: 'AutonomousMarketResearcher',
          },
          undefined,
          `AI detected ${output.signalsCreated} signal(s) in "${niche}", ${output.highConfidenceCount} high-confidence. Review recommended.`,
        );
        output.approvalIds.push(approval.id);
      } catch (err: any) {
        console.error(`[MarketResearch] Approval gate error:`, err.message);
      }
    }

    return output;
  }

  /**
   * Research a specific platform for a niche and save signals.
   */
  private async saveSignal(data: {
    niche: string;
    platform: string;
    signalType: string;
    title: string;
    description?: string;
    confidence: number;
    actionable: boolean;
  }): Promise<void> {
    const id = uuidv4();
    const now = new Date();
    try {
      await db.insert(marketSignals).values({
        id,
        niche: data.niche,
        platform: data.platform,
        signalType: data.signalType,
        title: data.title,
        description: data.description || null,
        confidence: data.confidence,
        actionable: data.actionable ? 1 : 0,
        createdAt: now,
      });
    } catch (err: any) {
      console.error(`[MarketResearch] Failed to save signal:`, err.message);
    }
  }

  /**
   * Get niches for a user from their integrations or goals context.
   */
  private async getNichesForUser(userId: string): Promise<string[]> {
    const defaultNiches = ['digital products', 'printables', 'social media templates'];

    // Try to get from Etsy shop (most reliable source of niche data)
    try {
      const creds = await this.getCredentials(userId, 'etsy');
      if (creds) {
        // Etsy shop categories can indicate the niche
        const shop = await etsyService.getShop(creds.access_token);
        if (shop && shop.shop_name) {
          return [shop.shop_name.replace(/[^a-zA-Z0-9 ]/g, '').trim(), ...defaultNiches];
        }
      }
    } catch {
      // Silently fall back to defaults
    }

    return defaultNiches;
  }

  /**
   * Extract top keywords from a text blob.
   */
  private extractKeywords(text: string): string[] {
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s#]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !['this', 'that', 'with', 'from', 'have', 'been', 'were', 'they'].includes(w));

    const freq = new Map<string, number>();
    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  /**
   * Get platform credentials for a user.
   */
  private async getCredentials(userId: string, platform: string): Promise<{ access_token: string; shop_id?: string } | null> {
    try {
      const { integrationService } = await import('./integrationService.js');
      return await integrationService.getCredentials(userId, platform);
    } catch {
      return null;
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const marketResearcher = new AutonomousMarketResearcher();
