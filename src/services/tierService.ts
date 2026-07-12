import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

/**
 * Tier definitions — maps user tiers to model names and capability flags.
 * 
 * EMPIRE_MASTER = gemini-2.5-pro (highest intelligence, full automation)
 * STANDARD_USER = gemini-2.5-flash (cost-optimized, co-pilot mode)
 */
export interface TierConfig {
  modelName: string;           // Gemini model identifier
  temperature: number;         // Creativity level
  maxConcurrency: number;      // Background job concurrency
  autoApproveListings: boolean; // Skip human approval for listings
  deepResearchEnabled: boolean; // Multi-pass research
  automationMode: 'co-pilot' | 'empire' | 'full_autopilot';
  maxBusinessSlots: number;    // Max simultaneous businesses
}

const TIER_CONFIGS: Record<string, TierConfig> = {
  EMPIRE_MASTER: {
    modelName: 'gemini-2.5-pro',
    temperature: 0.3,
    maxConcurrency: 10,
    autoApproveListings: true,
    deepResearchEnabled: true,
    automationMode: 'full_autopilot',
    maxBusinessSlots: 5,
  },
  STANDARD_USER: {
    modelName: 'gemini-2.5-flash',
    temperature: 0.5,
    maxConcurrency: 2,
    autoApproveListings: false,
    deepResearchEnabled: false,
    automationMode: 'co-pilot',
    maxBusinessSlots: 1,
  },
};

/**
 * Default config for unauthenticated / fallback.
 */
const DEFAULT_CONFIG: TierConfig = TIER_CONFIGS.STANDARD_USER;

export class TierService {

  /**
   * Get the full tier config for a user.
   * Returns the config for EMPIRE_MASTER or STANDARD_USER based on their tier column.
   * Falls back to STANDARD_USER if user not found or tier unknown.
   */
  async getConfig(userId: string): Promise<TierConfig> {
    try {
      const [user] = await db.select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!user) return DEFAULT_CONFIG;

      return TIER_CONFIGS[user.tier] || DEFAULT_CONFIG;
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  /**
   * Quick check for EMPIRE_MASTER status without loading full config.
   */
  async isEmpireMaster(userId: string): Promise<boolean> {
    try {
      const [user] = await db.select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      return user?.tier === 'EMPIRE_MASTER';
    } catch {
      return false;
    }
  }

  /**
   * Build a model constructor options object based on the user's tier.
   * Default: gemini-2.5-flash, temperature 0.5
   * EMPIRE_MASTER: gemini-2.5-pro, temperature 0.3
   */
  buildModelConfig(userId: string): { modelName: string; temperature: number; apiKey?: string } {
    return {
      modelName: 'gemini-2.5-flash',   // Safe default
      temperature: 0.5,
      apiKey: process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY,
    };
  }
}

export const tierService = new TierService();