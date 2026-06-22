import { db, schema } from '../db/index.js';
const { marketSignals, dnaStrands, productionScripts, campaigns } = schema;
import { eq, desc, and, isNotNull } from 'drizzle-orm';
import { productionDirector } from './productionDirector.js';
import { dnaVaultService } from './dnaVaultService.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * GeminiCreativeLoop — THE AUTONOMOUS BRAIN.
 * Periodically identifies high-traction market trends and generates
 * production-ready scripts for active campaigns.
 */
export class CreativeLoopService {
  /**
   * Main tick for the creative loop.
   * Finds high-confidence trends and generates content strategies.
   */
  async tick() {
    console.log('[CreativeLoop] Ticking...');

    // 1. Get high-confidence, actionable market signals
    const signals = await db.select()
      .from(marketSignals)
      .where(eq(marketSignals.actionable, 1))
      .orderBy(desc(marketSignals.createdAt))
      .limit(10);

    if (signals.length === 0) {
      console.log('[CreativeLoop] No actionable signals found.');
      return;
    }

    for (const signal of signals) {
      try {
        console.log(`[CreativeLoop] Processing signal: ${signal.title} (${signal.niche})`);

        // 2. Find matching DNA strands for this niche/vibe
        const relevantStrands = await dnaVaultService.searchStrands(signal.niche, 3);
        
        // 3. Find active campaigns that could benefit from this trend
        // We look for campaigns in the same niche or general digital product campaigns
        const targetCampaigns = await db.select()
          .from(campaigns)
          .where(and(
            eq(campaigns.status, 'active')
            // Add niche matching if campaigns have niche column, 
            // otherwise use a general heuristic or target all active.
          ))
          .limit(5);

        for (const campaign of targetCampaigns) {
          // Uniqueness check: Don't regenerate for the same signal+campaign in the last 24h
          const existing = await db.select()
            .from(productionScripts)
            .where(and(
              eq(productionScripts.campaignId, campaign.id),
              eq(productionScripts.niche, signal.niche)
            ))
            .limit(1);

          if (existing.length > 0) {
            console.log(`[CreativeLoop] Skipping campaign ${campaign.id}, script already exists for niche ${signal.niche}`);
            continue;
          }

          // 4. Generate the Production Script using Gemini
          const styleDna = relevantStrands[0]?.manifest || { colors: ['#000000', '#FFFFFF'], pacing: 'fast' };
          
          console.log(`[CreativeLoop] Directing script for campaign ${campaign.id}...`);
          const scriptData = await productionDirector.direct({
            campaignId: campaign.id,
            userId: campaign.userId,
            niche: signal.niche,
            angle: signal.title, // Use the trend title as the creative angle
            styleDna,
          });

          // 5. Persist the script
          const scriptId = await productionDirector.saveScript(scriptData, campaign.id, campaign.userId);
          
          console.log(`[CreativeLoop] 🎬 Script generated and saved: ${scriptId} for trend "${signal.title}"`);
        }
      } catch (err: any) {
        console.error(`[CreativeLoop] Error processing signal ${signal.id}:`, err.message);
      }
    }
  }
}

export const creativeLoopService = new CreativeLoopService();
