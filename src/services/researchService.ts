import axios from 'axios';

export interface TrendData {
  platform: string;
  content: string;
  timestamp: string;
  roiPotential: number; // 1-100
  platformIcon: string;
  niche: string;
}

export class ResearchService {
  private readonly CACHE_KEY = 'EmpireLaunch AI:trends:all';
  private readonly CACHE_TTL = 3600; // 1 hour

  async fetchEtsyTrends(): Promise<TrendData[]> {
    // Mocking Etsy trend data
    return [
      { 
        platform: 'Etsy', 
        content: 'Minimalist digital planners are seeing a 40% increase in searches.', 
        timestamp: new Date().toISOString(),
        roiPotential: 85,
        platformIcon: 'etsy-icon',
        niche: 'Digital Products'
      },
      { 
        platform: 'Etsy', 
        content: 'Sustainable home decor is trending in the UK market.', 
        timestamp: new Date().toISOString(),
        roiPotential: 70,
        platformIcon: 'etsy-icon',
        niche: 'Home Decor'
      },
      { 
        platform: 'Etsy', 
        content: 'Customizable wedding invitations remain a top seller.', 
        timestamp: new Date().toISOString(),
        roiPotential: 75,
        platformIcon: 'etsy-icon',
        niche: 'Events'
      },
    ];
  }

  async fetchSocialTrends(): Promise<TrendData[]> {
    // Mocking Social Media trend data (TikTok/Instagram)
    return [
      { 
        platform: 'TikTok', 
        content: '"Day in the life" videos with productivity focus are trending.', 
        timestamp: new Date().toISOString(),
        roiPotential: 90,
        platformIcon: 'tiktok-icon',
        niche: 'Productivity'
      },
      { 
        platform: 'Instagram', 
        content: 'Aesthetic office setups and desk tours are highly engaging.', 
        timestamp: new Date().toISOString(),
        roiPotential: 80,
        platformIcon: 'instagram-icon',
        niche: 'Lifestyle'
      },
    ];
  }

  async getAllTrends(): Promise<TrendData[]> {
    try {
      /*
      // Try to get from cache first
      const cachedTrends = await redisConnection.get(this.CACHE_KEY);
      if (cachedTrends) {
        console.log('Serving trends from Redis cache');
        return JSON.parse(cachedTrends);
      }
      */

      console.log('Fetching fresh trends (caching disabled)');
      const etsy = await this.fetchEtsyTrends();
      const social = await this.fetchSocialTrends();
      const allTrends = [...etsy, ...social];

      /*
      // Store in cache
      await redisConnection.setex(this.CACHE_KEY, this.CACHE_TTL, JSON.stringify(allTrends));
      */

      return allTrends;
    } catch (error) {
      console.error('Error fetching trends:', error);
      // Fallback to fresh fetch if error occurs
      const etsy = await this.fetchEtsyTrends();
      const social = await this.fetchSocialTrends();
      return [...etsy, ...social];
    }
  }
}

export const researchService = new ResearchService();