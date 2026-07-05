import { canvaService } from './canvaService.js';
import { dnaVaultService } from './dnaVaultService.js';
import { webSocketService } from './websocketService.js';

export class CanvaDnaService {
  /**
   * Perform deep Style DNA extraction from Canva's public template gallery.
   * 
   * Uses Playwright to browse Canva's public template categories (social media,
   * logos, flyers, presentations, etc.) and extracts color palettes, typography
   * signatures, and layout patterns from trending public designs.
   * 
   * Results are stored as **Global DNA** (`isGlobal: true`) so the AI can use
   * that intelligence for all users — no personal Canva account accessed.
   * No API keys needed — browser automation is the only tool.
   */
  async performDeepExtraction(userId: string): Promise<number> {
    console.log(`[CanvaDna] Starting public template Style DNA harvest for user ${userId}`);
    webSocketService.notifyUser(userId, 'ai-log', {
      message: '[CANVA] 🧬 Browsing trending public templates for Style DNA (colors, fonts, layouts)...'
    });

    try {
      // Extract DNA from Canva's public template gallery via Playwright
      const publicStrands = await canvaService.extractPublicTemplateDna();
      console.log(`[CanvaDna] Extracted ${publicStrands.length} public template strands`);

      // Store all strands as Global DNA (isGlobal: true, no userId)
      let savedCount = 0;
      for (const strand of publicStrands) {
        const globalStrand = {
          ...strand,
          isGlobal: true,
          isSynthesized: false,
        };
        await dnaVaultService.storeStrand(globalStrand);
        savedCount++;
      }

      // Also add a summary strand for this harvest session
      await dnaVaultService.storeStrand({
        category: 'niche_pattern',
        subCategory: 'canva_public_harvest',
        manifest: {
          harvestTimestamp: new Date().toISOString(),
          strandCount: savedCount,
          categoriesScanned: publicStrands.map(s => s.metadata?.templateCategory).filter(Boolean),
          source: 'canva_public_template_gallery',
        },
        performanceScore: 85,
        sourcePlatform: 'canva',
        isGlobal: true,
        isSynthesized: false,
        metadata: {
          type: 'harvest_summary',
          userId,
          harvestDate: new Date().toISOString(),
        },
      });

      webSocketService.notifyUser(userId, 'ai-log', {
        message: `[CANVA] ✅ Public template harvest complete! Added ${savedCount} global Style DNA strands to the Universal Vault.`
      });

      return savedCount;
    } catch (error: any) {
      console.error(`[CanvaDna] Public template harvest failed: ${error.message}`);
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `[CANVA] ⚠️ Public template harvest encountered an error: ${error.message}`
      });
      throw error;
    }
  }
}

export const canvaDnaService = new CanvaDnaService();