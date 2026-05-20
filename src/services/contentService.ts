import { mediaService } from './mediaService.js';

export interface ContentDraft {
  title: string;
  body: string;
  mediaUrl?: string;
  platform: string;
}

export class ContentService {
  async generateContent(goal: string, researchData: any, marketBrief?: any): Promise<ContentDraft[]> {
    console.log("Generating content based on research and market intelligence...");
    
    let niche = "General";
    let title = goal;
    
    if (marketBrief) {
        let brief = marketBrief;
        if (typeof brief === 'string') {
            try { brief = JSON.parse(brief); } catch (e) {}
        }
        title = brief.suggestedTitle || goal;
        niche = brief.targetStyle || niche;
    }

    if (niche === "General" && researchData) {
        let data = researchData;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) {}
        }
        niche = data.trendingNiches?.[0]?.niche || niche;
    }

    // Use internal media service to generate a product image
    const productImagePath = await mediaService.createProductImage(title, niche);

    return [
      {
        title: `${niche} - Product Post`,
        body: `Check out our new ${title}! Trending in ${niche}. #EmpireLaunch AI #ai`,
        platform: "Instagram",
        mediaUrl: productImagePath
      },
      {
        title: `${niche} - Listing Draft`,
        body: `Optimized listing for ${title}. Features: ${marketBrief?.keyFeatures?.join(', ') || 'High quality design'}.`,
        platform: "Etsy",
        mediaUrl: productImagePath
      }
    ];
  }
}

export const contentService = new ContentService();
