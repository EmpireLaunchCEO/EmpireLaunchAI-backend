import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser, JsonOutputParser } from '@langchain/core/output_parsers';
import { neuralBrowserService } from './neuralBrowserService.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { resolveModelForUser, getDefaultModel } from '../utils/resolveModel.js';

export interface MarketListing {
  title: string;
  price: number;
  tags: string[];
  style: string;
  features: string[];
  platform: string;
  isBestSeller: boolean;
}

export class MarketIntelligenceService {
  async fetchEtsyBestSellers(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const results = await neuralBrowserService.executeAutomation('system', [
        { action: 'navigate', url: `https://www.etsy.com/search?q=${encodeURIComponent(niche)}+best+seller` },
        { action: 'wait', value: '.v2-listing-card' },
        { 
          action: 'extract', 
          selector: '.v2-listing-card',
          multiple: true,
          fields: {
            title: 'a.v2-listing-card__title',
            price: '.currency-value',
            isBestSeller: '.wt-badge--best-seller'
          }
        }
      ]) as any;

      const listings = results?.['.v2-listing-card'] || [];
      if (Array.isArray(listings) && listings.length > 0) {
        return listings.map((l: any) => ({
          title: l.title || `${niche} Product`,
          price: parseFloat(l.price) || 9.99,
          tags: [niche, "digital"],
          style: "Trending",
          features: ["Optimized"],
          platform: "Etsy",
          isBestSeller: !!l.isBestSeller,
        }));
      }
    } catch (e) {
      console.warn('[MarketIntelligence] Scraping failed');
    }

    try {
      const model = userId ? await resolveModelForUser(userId) : getDefaultModel();
      const template = `Analyze digital product trends for "{niche}". Return JSON array: title, price, tags, style, features, isBestSeller, platform: "Etsy".`;
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new StringOutputParser()]);
      const result = await chain.invoke({ niche });
      return JSON.parse(result);
    } catch (e) {
      return [];
    }
  }

  async fetchVisualTrends(niche: string, userId?: string): Promise<any[]> {
    try {
      const model = userId ? await resolveModelForUser(userId) : getDefaultModel();
      const template = `Analyze TikTok and Pinterest trends for "{niche}". Return JSON array: style, traction, platform, description.`;
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new StringOutputParser()]);
      const result = await chain.invoke({ niche });
      return JSON.parse(result);
    } catch (e) {
      return [];
    }
  }
}

export const marketIntelligenceService = new MarketIntelligenceService();
