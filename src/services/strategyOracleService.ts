import { db, schema } from '../db/index.js';
import { eq, desc, and, gte } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { notificationService } from './notificationService.js';

export interface StrategySuggestion {
  type: 'TREND_PIVOT' | 'SEO_OPTIMIZATION' | 'AD_BOOST' | 'INVENTORY_ALERT';
  title: string;
  suggestion: string;
  reasoning: string;
  parameters: any;
  roiImpact: number;
}

export class StrategyOracleService {
  async generateSuggestions(userId: string) {
    try {
      // 1. Fetch recent performance data
      const recentPerformance = await db.select()
        .from(schema.historicalPerformance)
        .where(eq(schema.historicalPerformance.userId, userId))
        .orderBy(desc(schema.historicalPerformance.date))
        .limit(7);

      if (recentPerformance.length === 0) {
        return [];
      }

      const latest = recentPerformance[0];
      const suggestions: StrategySuggestion[] = [];

      // 2. Logic: High Engagement but Low Revenue -> SEO or Conversion Optimization
      if (latest.engagement > 5000 && latest.revenue < 10000) {
        suggestions.push({
          type: 'SEO_OPTIMIZATION',
          title: 'Optimize Etsy Conversion',
          suggestion: 'Your TikTok engagement is high, but Etsy conversion is lagging. Refresh listing tags and images.',
          reasoning: 'The Revenue Oracle detected high traffic overflow from social but low click-through to sales.',
          parameters: { platform: 'etsy', action: 'REFRESH_TAGS' },
          roiImpact: 15000 // $150
        });
      }

      // 3. Logic: High Revenue but Low Ad Spend -> Boost Ads
      if (latest.revenue > 30000 && latest.adSpend < 5000) {
        suggestions.push({
          type: 'AD_BOOST',
          title: 'Increase Ad Spend',
          suggestion: 'Product X is performing well organically. Increasing ad spend could multiply your returns.',
          reasoning: 'Positive ROI detected on organic traffic. Ad scaling recommended.',
          parameters: { platform: 'tiktok', budget_increase: 2000 },
          roiImpact: 50000 // $500
        });
      }

      // 4. Logic: Sentiment Drop
      if (latest.sentimentScore && latest.sentimentScore < 60) {
        suggestions.push({
          type: 'TREND_PIVOT',
          title: 'Address Customer Feedback',
          suggestion: 'Recent comments indicate dissatisfaction with [Topic]. Consider pivoting design style.',
          reasoning: 'Neural Discovery found a significant drop in sentiment scores in the last 24 hours.',
          parameters: { action: 'SENTIMENT_ANALYSIS_DEEP_DIVE' },
          roiImpact: 0
        });
      }

      // Save suggestions to database
      for (const s of suggestions) {
        await db.insert(schema.strategySuggestions).values({
          id: uuidv4(),
          userId,
          type: s.type,
          title: s.title,
          suggestion: s.suggestion,
          reasoning: s.reasoning,
          parameters: s.parameters,
          roiImpact: s.roiImpact,
          status: 'pending',
          createdAt: new Date()
        });
        
        // Notify user about new strategic intervention
        await notificationService.notifyUser(userId, `New Strategic Suggestion: ${s.title}. Estimated ROI impact: $${s.roiImpact / 100}.`);
      }

      return suggestions;
    } catch (error: any) {
      console.error('Strategy Oracle failed to generate suggestions:', error);
      await notificationService.notifyUser(userId, `Strategy Oracle encountered an error: ${error.message}`);
      return [];
    }
  }
}

export const strategyOracle = new StrategyOracleService();
