import { PlatformAdapter, PlatformMetrics } from './platformAdapter.js';

export class TikTokAdapter implements PlatformAdapter {
  getPlatformName(): string {
    return 'tiktok';
  }

  async fetchMetrics(userId: string, date: Date): Promise<PlatformMetrics> {
    // Mock TikTok engagement metrics
    return {
      revenue: 0,
      engagement: Math.floor(Math.random() * 10000), // Video views
      adSpend: Math.floor(Math.random() * 2000), // Ad spend in cents
      sentimentScore: 75,
      breakdown: {
        likes: 450,
        shares: 30,
        comments: 15
      }
    };
  }
}
