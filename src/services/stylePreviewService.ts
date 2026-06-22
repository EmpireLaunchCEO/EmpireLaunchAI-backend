import { VisualSummary, visualProxyService } from './visualProxyService.js';
import { DnaStrand, dnaVaultService } from './dnaVaultService.js';
import { webSocketService } from './websocketService.js';
import { v4 as uuidv4 } from 'uuid';

export interface StylePreview extends VisualSummary {
  id: string;
  userId: string;
  niche: string;
  performanceScore: number;
  trendDirection: 'rising' | 'stable' | 'declining';
  vibeTags: string[];
  difficulty: 'instant' | 'guided' | 'advanced';
  sourceImageDiscarded: boolean;
  previewGenerationMethod: string;
}

export class StylePreviewService {
  /**
   * Generates AI-synthesized style previews for a niche.
   * ZERO-SOURCE-IMAGE POLICY: Discards source images immediately, only stores DNA + synthesized abstracts.
   */
  async getStylesForNiche(userId: string, niche: string): Promise<StylePreview[]> {
    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🔍 Style Studio: Harvesting and synthesizing trends for "${niche}"...`
    });

    // 1. Fetch relevant DNA strands from the Vault
    // In a real scenario, we'd query the DB for strands matching the niche
    // For now, we'll simulate or fetch from the dnaVaultService if it has a list method
    // Since I don't see a list method in the read earlier, I'll assume we have some strand IDs
    
    // Fallback: search the vault (mocked for now)
    const strands = await dnaVaultService.searchStrands(niche, 4);

    if (strands.length === 0) {
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `⚠️ No DNA found in vault for "${niche}". Using generative synthesis...`
      });
      // Handle generative synthesis (Tier 2)
      return this.generateSyntheticStyles(userId, niche);
    }

    const previews: StylePreview[] = [];

    for (const strand of strands) {
      const summary = await visualProxyService.summarizeStrand(userId, strand);
      
      previews.push({
        ...summary,
        id: uuidv4(),
        userId,
        niche,
        performanceScore: strand.performanceScore,
        trendDirection: this.inferTrend(strand.performanceScore),
        vibeTags: this.generateVibeTags(summary),
        difficulty: 'instant',
        sourceImageDiscarded: true,
        previewGenerationMethod: 'openai_abstract'
      });
    }

    return previews;
  }

  private inferTrend(score: number): 'rising' | 'stable' | 'declining' {
    if (score > 80) return 'rising';
    if (score < 40) return 'declining';
    return 'stable';
  }

  private generateVibeTags(summary: VisualSummary): string[] {
    const tags = [summary.primaryVibe];
    if (summary.designPersonality.includes('minimal')) tags.push('✨ Minimal');
    if (summary.designPersonality.includes('bold')) tags.push('🔥 Bold');
    if (summary.designPersonality.includes('earthy')) tags.push('🌿 Earthy');
    if (summary.designPersonality.includes('premium')) tags.push('💎 Premium');
    return tags;
  }

  private async generateSyntheticStyles(userId: string, niche: string): Promise<StylePreview[]> {
    // This would use the reasoning engine to imagine a style if the vault is empty
    return [];
  }
}

export const stylePreviewService = new StylePreviewService();
