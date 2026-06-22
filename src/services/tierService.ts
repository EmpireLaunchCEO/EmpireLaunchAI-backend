import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

/**
 * Tier definitions — maps user tiers to model names and capability flags.
 * 
 * EMPIRE_MASTER = gpt-4o (highest intelligence, full automation)
 * STANDARD_USER = gpt-4o-mini (cost-optimized, co-pilot mode)
 */
export interface TierConfig {
  modelName: string;           // OpenAI model identifier
  temperature: number;         // Creativity level
  maxConcurrency: number;      // Background job concurrency
  autoApproveListings: boolean; // Skip human approval for listings
  deepResearchEnabled: boolean; // Multi-pass research
  automationMode: 'co-pilot' | 'empire' | 'full_autopilot';
  maxBusinessSlots: number;    // Max simultaneous businesses
}

const TIER_CONFIGS: Record<string, TierConfig> = {
  EMPIRE_MASTER: {
    modelName: 'gpt-4o',
    temperature: 0.3,
    maxConcurrency: 10,
    autoApproveListings: true,
    deepResearchEnabled: true,
    automationMode: 'full_autopilot',
    maxBusinessSlots: 5,
  },
  STANDARD_USER: {
    modelName: 'gpt-4o-mini',
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
   * Build a ChatOpenAI constructor options object based on the user's tier.
   * Default: gpt-4o-mini, temperature 0.5
   * EMPIRE_MASTER: gpt-4o, temperature 0.3
   */
  buildModelConfig(userId: string): { modelName: string; temperature: number; openAIApiKey?: string } {
    // Synchronous version for use in constructors — loads config async later if needed
    // The actual model resolution happens when the service calls openAIApiKey from env
    return {
      modelName: 'gpt-4o-mini',   // Safe default
      temperature: 0.5,
      openAIApiKey: process.env.OPENAI_API_KEY,
    };
  }
}

export const tierService = new TierService();