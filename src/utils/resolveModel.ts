import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';

/**
 * Model providers and tiers.
 */
export interface ModelConfig {
  provider: 'openai' | 'google';
  modelName: string;
  temperature: number;
}

const MODEL_MAP: Record<string, ModelConfig> = {
  EMPIRE_MASTER: { provider: 'openai', modelName: 'gpt-4o-mini', temperature: 0.3 },
  STANDARD_USER: { provider: 'openai', modelName: 'gpt-4o-mini', temperature: 0.5 },
  STUDIO_INTEL: { provider: 'openai', modelName: 'gpt-4o-mini', temperature: 0.2 },
};

const DEFAULT_MODEL = MODEL_MAP.STANDARD_USER;

const tierCache = new Map<string, string>();

async function getUserTier(userId: string): Promise<string> {
  if (tierCache.has(userId)) return tierCache.get(userId)!;
  try {
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    });
    const tier = user?.tier || 'STANDARD_USER';
    tierCache.set(userId, tier);
    return tier;
  } catch (error) {
    return 'STANDARD_USER';
  }
}

export async function resolveModelForUser(userId?: string): Promise<BaseChatModel> {
  if (!userId) return getDefaultModel();
  const tier = await getUserTier(userId);
  const config = MODEL_MAP[tier] || DEFAULT_MODEL;

  if (config.provider === 'google') {
    return new ChatGoogleGenerativeAI({
      model: config.modelName,
      temperature: config.temperature,
      apiKey: process.env.GOOGLE_API_KEY || 'DUMMY_KEY',
    });
  }

  return new ChatOpenAI({
    modelName: config.modelName,
    temperature: config.temperature,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}

export async function resolveStudioReasoner(): Promise<BaseChatModel> {
  const config = MODEL_MAP.STUDIO_INTEL;
  return new ChatOpenAI({
    modelName: config.modelName,
    temperature: config.temperature,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}

export function getDefaultModel(): BaseChatModel {
  return new ChatOpenAI({
    modelName: 'gpt-4o-mini',
    temperature: 0.5,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}

export async function getModelConfig(userId: string): Promise<ModelConfig> {
  const tier = await getUserTier(userId);
  return MODEL_MAP[tier] || DEFAULT_MODEL;
}
