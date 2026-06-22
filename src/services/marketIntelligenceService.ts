import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser, JsonOutputParser } from '@langchain/core/output_parsers';
import { neuralBrowserService } from './neuralBrowserService.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { resolveModelForUser, getDefaultModel } from '../utils/resolveModel.js';
import axios from 'axios';

export interface MarketListing {
  title: string;
  price?: number;
  tags?: string[];
  style?: string;
  features?: string[];
  platform: string;
  url?: string;
  imageUrl?: string;
  externalId?: string;
  isBestSeller?: boolean;
  signals?: {
    inBasket?: string;
    reviewCount?: number;
    reviewRecency?: string;
    ordersInQueue?: string;
    duplicates?: number;
    likes?: number;
    views?: number;
    subscribers?: string;
    isStaffPick?: boolean;
    isCurated?: boolean;
  };
}

export class MarketIntelligenceService {
  async fetchEtsyBestSellers(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const results = await neuralBrowserService.executeAutomation(userId || 'system', [
        { action: 'navigate', url: `https://www.etsy.com/search?q=${encodeURIComponent(niche)}&explicit_free_shipping=false&item_type=all&digital=true&ship_to=US&order=highest_reviews` },
        { action: 'wait', value: '.v2-listing-card' },
        {
          action: 'extract',
          selector: '.v2-listing-card',
          multiple: true,
          fields: {
            title: 'h3',
            price: '.currency-value',
            isBestSeller: 'span.wt-badge--best-seller, span.wt-badge--sales-pitch',
            inBasket: '.wt-badge--basket, span.wt-badge--neutral:has-text("basket"), .wt-text-success',
            reviewCount: '.wt-text-caption.wt-text-grey',
            url: 'a@href',
            imageUrl: 'img@src'
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
          url: l.url,
          imageUrl: l.imageUrl,
          externalId: l.url?.split('/listing/')[1]?.split('/')[0],
          isBestSeller: !!l.isBestSeller,
          signals: {
            inBasket: l.inBasket || undefined,
            reviewCount: parseInt(l.reviewCount?.replace(/[^0-9]/g, '')) || 0,
          }
        }));
      }
    } catch (e) {
      console.warn('[MarketIntelligence] Etsy scraping failed');
    }
    return this.fallbackToLLM(niche, 'Etsy', userId);
  }

  async fetchFigmaCommunityTrends(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const response = await axios.get(`https://www.figma.com/api/community/files?page=1&query=${encodeURIComponent(niche)}&sort=popular`);
      const files = response.data?.meta?.files || [];
      return files.map((f: any) => ({
        title: f.name,
        platform: 'Figma Community',
        url: `https://www.figma.com/community/file/${f.id}`,
        imageUrl: f.thumbnail_url,
        externalId: f.id,
        signals: {
          duplicates: f.duplicate_count,
          likes: f.like_count
        }
      }));
    } catch (e) {
      console.warn('[MarketIntelligence] Figma API failed, falling back to LLM');
      return this.fallbackToLLM(niche, 'Figma Community', userId);
    }
  }

  async fetchKittlTrends(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const results = await neuralBrowserService.executeAutomation(userId || 'system', [
        { action: 'navigate', url: `https://www.kittl.com/community/explore?q=${encodeURIComponent(niche)}` },
        { action: 'wait', value: '.template-card' },
        {
          action: 'extract',
          selector: '.template-card',
          multiple: true,
          fields: {
            title: 'h3',
            imageUrl: 'img@src',
            useCount: '.use-count', // Hypothetical selector based on report
            likes: '.like-count',
            isStaffPick: '.staff-pick-badge',
            url: 'a@href'
          }
        }
      ]) as any;
      const items = results?.['.template-card'] || [];
      return items.map((l: any) => ({
        title: l.title,
        platform: 'Kittl',
        url: l.url,
        imageUrl: l.imageUrl,
        externalId: l.url?.split('/').pop(),
        signals: {
          duplicates: parseInt(l.useCount?.replace(/[^0-9]/g, '')) || 0,
          likes: parseInt(l.likes?.replace(/[^0-9]/g, '')) || 0,
          isStaffPick: !!l.isStaffPick
        }
      }));
    } catch (e) {
      return this.fallbackToLLM(niche, 'Kittl', userId);
    }
  }

  async fetchBehanceTrends(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const results = await neuralBrowserService.executeAutomation(userId || 'system', [
        { action: 'navigate', url: `https://www.behance.net/search/projects?search=${encodeURIComponent(niche)}&sort=appreciations` },
        { action: 'wait', value: '.ProjectCover-container-ADp' },
        {
          action: 'extract',
          selector: '.ProjectCover-container-ADp',
          multiple: true,
          fields: {
            title: '.ProjectCover-title-2_3',
            imageUrl: 'img@src',
            likes: '.ProjectCover-stat-1l8',
            isCurated: '.ProjectCover-featured-2_3',
            url: 'a@href'
          }
        }
      ]) as any;
      const items = results?.['.ProjectCover-container-ADp'] || [];
      return items.map((l: any) => ({
        title: l.title,
        platform: 'Behance',
        url: l.url,
        imageUrl: l.imageUrl,
        externalId: l.url?.split('/project/')[1]?.split('/')[0],
        signals: {
          likes: parseInt(l.likes?.replace(/[^0-9]/g, '')) || 0,
          isCurated: !!l.isCurated
        }
      }));
    } catch (e) {
      return this.fallbackToLLM(niche, 'Behance', userId);
    }
  }

  async fetchRedbubbleTrends(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const results = await neuralBrowserService.executeAutomation(userId || 'system', [
        { action: 'navigate', url: `https://www.redbubble.com/shop/?query=${encodeURIComponent(niche)}&sortOrder=trending` },
        { action: 'wait', value: '[data-testid="search-result-card"]' },
        {
          action: 'extract',
          selector: '[data-testid="search-result-card"]',
          multiple: true,
          fields: {
            title: '.styles__title--1Z_X_',
            imageUrl: 'img@src',
            isBestSeller: '.styles__bestSeller--2V_X_',
            url: 'a@href'
          }
        }
      ]) as any;
      const items = results?.['[data-testid="search-result-card"]'] || [];
      return items.map((l: any) => ({
        title: l.title,
        platform: 'Redbubble',
        url: l.url,
        imageUrl: l.imageUrl,
        externalId: l.url?.split('/').pop(),
        isBestSeller: !!l.isBestSeller
      }));
    } catch (e) {
      return this.fallbackToLLM(niche, 'Redbubble', userId);
    }
  }

  async fetchArtStationTrends(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const response = await axios.get(`https://www.artstation.com/api/v2/search/projects.json?q=${encodeURIComponent(niche)}&sorting=trending`);
      const projects = response.data?.data || [];
      return projects.map((p: any) => ({
        title: p.title,
        platform: 'ArtStation',
        url: p.permalink,
        imageUrl: p.cover_image_url,
        externalId: p.hash_id || p.id?.toString(),
        signals: {
          likes: p.likes_count,
          views: p.views_count
        }
      }));
    } catch (e) {
      return this.fallbackToLLM(niche, 'ArtStation', userId);
    }
  }

  async fetchSubstackTrends(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const response = await axios.get(`https://substack.com/api/v1/discover/top-publications`);
      const publications = response.data || [];
      return publications
        .filter((p: any) => p.niche === niche || p.tags?.includes(niche))
        .map((p: any) => ({
          title: p.name,
          platform: 'Substack',
          imageUrl: p.cover_image_url || p.logo_url,
          externalId: p.id?.toString(),
          signals: {
            subscribers: p.subscriber_count_tier
          }
        }));
    } catch (e) {
      return this.fallbackToLLM(niche, 'Substack', userId);
    }
  }

  async fetchTikTokTrends(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const results = await neuralBrowserService.executeAutomation(userId || 'system', [
        { action: 'navigate', url: `https://www.tiktok.com/search?q=${encodeURIComponent(niche)}` },
        { action: 'wait', value: '[data-e2e="search-video-container"]' },
        {
          action: 'extract',
          selector: '[data-e2e="search-video-container"]',
          multiple: true,
          fields: {
            title: '[data-e2e="search-card-video-caption"]',
            views: '[data-e2e="video-views"]',
            likes: '[data-e2e="video-likes"]'
          }
        }
      ]) as any;
      const items = results?.['[data-e2e="search-video-container"]'] || [];
      return items.map((l: any) => ({
        title: l.title || `${niche} TikTok`,
        platform: 'TikTok',
        signals: {
          views: l.views,
          likes: l.likes
        }
      }));
    } catch (e) {
      return this.fallbackToLLM(niche, 'TikTok', userId);
    }
  }

  async fetchPinterestTrends(niche: string, userId?: string): Promise<MarketListing[]> {
    try {
      const results = await neuralBrowserService.executeAutomation(userId || 'system', [
        { action: 'navigate', url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(niche)}` },
        { action: 'wait', value: '[data-test-id="pin"]' },
        {
          action: 'extract',
          selector: '[data-test-id="pin"]',
          multiple: true,
          fields: {
            title: '[data-test-id="pin-title"]',
            description: '[data-test-id="pin-description"]'
          }
        }
      ]) as any;
      const items = results?.['[data-test-id="pin"]'] || [];
      return items.map((l: any) => ({
        title: l.title || l.description || `${niche} Pin`,
        platform: 'Pinterest',
      }));
    } catch (e) {
      return this.fallbackToLLM(niche, 'Pinterest', userId);
    }
  }

  private async fallbackToLLM(niche: string, platform: string, userId?: string): Promise<MarketListing[]> {
    try {
      const model = userId ? await resolveModelForUser(userId) : getDefaultModel();
      const template = `Analyze digital product trends for "{niche}" on ${platform}. Return JSON array of objects with title, price (if applicable), tags, style, features, isBestSeller (boolean), platform: "${platform}".`;
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      const result = await chain.invoke({ niche }) as any;
      return Array.isArray(result) ? result : [];
    } catch (e) {
      return [];
    }
  }

  async fetchVisualTrends(niche: string, userId?: string): Promise<any[]> {
    try {
      const model = userId ? await resolveModelForUser(userId) : getDefaultModel();
      const template = `Analyze TikTok and Pinterest trends for "{niche}". Return JSON array: style, traction, platform, description.`;
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      const result = await chain.invoke({ niche }) as any;
      return Array.isArray(result) ? result : [];
    } catch (e) {
      return [];
    }
  }

  async fetchCanvaTemplates(niche: string, userId?: string): Promise<any[]> {
    try {
      const results = await neuralBrowserService.executeAutomation(userId || 'system', [
        { action: 'navigate', url: `https://www.canva.com/templates/?query=${encodeURIComponent(niche)}&pricing=free` },
        { action: 'wait', value: '[data-testid="template-card"]' },
        {
          action: 'extract',
          selector: '[data-testid="template-card"]',
          multiple: true,
          fields: {
            title: 'img@alt',
            thumbnail: 'img@src',
            url: 'a@href'
          }
        }
      ]) as any;
      const templates = results?.['[data-testid="template-card"]'] || [];
      return Array.isArray(templates) ? templates : [];
    } catch (e) {
      console.warn('[MarketIntelligence] Canva scraping failed');
      return [];
    }
  }
}

export const marketIntelligenceService = new MarketIntelligenceService();
