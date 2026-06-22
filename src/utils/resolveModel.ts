import { ChatOpenAI } from '@langchain/openai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

/**
 * Model providers and tiers.
 * Maps user tiers to specific model configurations.
 */
interface ModelConfig {
  provider: 'openai' | 'google';
  modelName: string;
  temperature: number;
}

const MODEL_MAP: Record<string, ModelConfig> = {
  EMPIRE_MASTER: { provider: 'openai', modelName: 'gpt-4o', temperature: 0.3 },
  STANDARD_USER: { provider: 'openai', modelName: 'gpt-4o-mini', temperature: 0.5 },
  STUDIO_INTEL: { provider: 'google', modelName: 'gemini-1.5-flash', temperature: 0.2 },
};

const DEFAULT_MODEL = MODEL_MAP.STANDARD_USER;

// Cache tier lookups in-memory to avoid DB hits on every construction
const tierCache = new Map<string, string>();

/**
 * Cached lookup of a user's tier from the database.
 */
async function getUserTier(userId: string): Promise<string> {
  if (tierCache.has(userId)) {
    return tierCache.get(userId)!;
  }
  try {
    const [user] = await db.select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const tier = user?.tier || 'STANDARD_USER';
    tierCache.set(userId, tier);
    return tier;
  } catch {
    return 'STANDARD_USER';
  }
}

/**
 * Build a tier-optimized ChatOpenAI instance for the given user.
 *
 * All standard consumers expect `ChatOpenAI` — this maintains that contract.
 * For non-OpenAI providers (e.g. Gemini), call resolveStudioReasoner() separately.
 */
export async function resolveModelForUser(
  userId: string
): Promise<ChatOpenAI> {
  const tier = await getUserTier(userId);
  const config = MODEL_MAP[tier] || DEFAULT_MODEL;

  if (config.provider === 'google') {
    // Fallback: Google users get gpt-4o-mini since all consumers expect ChatOpenAI
    return new ChatOpenAI({
      modelName: 'gpt-4o-mini',
      temperature: config.temperature,
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  return new ChatOpenAI({
    modelName: config.modelName,
    temperature: config.temperature,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}

/**
 * Specifically resolve the High-Intelligence Reasoner for the Empire Studio.
 * Returns a BaseChatModel (could be Gemini, GPT-4, etc.)
 */
export async function resolveStudioReasoner(): Promise<BaseChatModel> {
  const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
  return new ChatGoogleGenerativeAI({
    model: MODEL_MAP.STUDIO_INTEL.modelName,
    temperature: MODEL_MAP.STUDIO_INTEL.temperature,
    apiKey: process.env.GOOGLE_API_KEY,
  });
}

/**
 * Synchronous fallback for cases where we can't await.
 */
export function getDefaultModel(): ChatOpenAI {
  return new ChatOpenAI({
    modelName: DEFAULT_MODEL.modelName,
    temperature: DEFAULT_MODEL.temperature,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}

/**
 * Get the model config for a user (without constructing the client).
 */
export async function getModelConfig(userId: string): Promise<ModelConfig> {
  const tier = await getUserTier(userId);
  return MODEL_MAP[tier] || DEFAULT_MODEL;
}

/**
 * Clear the tier cache.
 */
export function clearTierCache() {
  tierCache.clear();
}
