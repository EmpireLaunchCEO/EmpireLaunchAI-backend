import { canvaService } from './canvaService.js';
import { dnaVaultService } from './dnaVaultService.js';
import { webSocketService } from './websocketService.js';

export class CanvaDnaService {
    /**
     * Performs a deep DNA extraction from a user's Canva account.
     * This captures Brand Kits (colors, fonts) and Design intelligence (layouts).
     */
    async performDeepExtraction(userId: string) {
        console.log(`[CanvaDna] Starting deep DNA extraction for user \${userId}`);
        webSocketService.notifyUser(userId, 'ai-log', {
            message: '[CANVA] 🧬 Starting deep Style DNA harvest from your Brand Kits and Designs...'
        });

        try {
            // 1. Extract Brand Kit DNA
            const brandKitStrands = await canvaService.extractBrandKitDna(userId);
            console.log(`[CanvaDna] Extracted \${brandKitStrands.length} brand kit strands`);

            // 2. Extract User Design DNA
            const designStrands = await canvaService.extractUserDesignDna(userId);
            console.log(`[CanvaDna] Extracted \${designStrands.length} design strands`);

            const allStrands = [...brandKitStrands, ...designStrands];

            // 3. Store in Vault
            let savedCount = 0;
            for (const strand of allStrands) {
                // Ensure userId is set and isGlobal is false for user-owned DNA
                // We also set isSynthesized to false because this is a direct import of user's own style, 
                // not a new synthesis (though it can be used for synthesis later).
                const personalizedStrand = {
                    ...strand,
                    userId,
                    isGlobal: false,
                    isSynthesized: false 
                };
                await dnaVaultService.storeStrand(personalizedStrand);
                savedCount++;
            }

            webSocketService.notifyUser(userId, 'ai-log', {
                message: `[CANVA] ✅ Deep harvest complete! Added \${savedCount} private style strands to your DNA Vault.`
            });

            return savedCount;
        } catch (error: any) {
            console.error(`[CanvaDna] Deep extraction failed: \${error.message}`);
            webSocketService.notifyUser(userId, 'ai-log', {
                message: `[CANVA] ⚠️ Deep harvest encountered an error: \${error.message}`
            });
            throw error;
        }
    }
}

export const canvaDnaService = new CanvaDnaService();
