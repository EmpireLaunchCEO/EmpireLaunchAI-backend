import { db, schema } from '../db/index.js';
const { blueprints } = schema;
import { aiScriptingService } from './aiScriptingService.js';
import { originalityService } from './originalityService.js';
import { mediaService } from './mediaService.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';

export interface BlueprintRequest {
  userId: string;
  platform: 'kittl' | 'capcut';
  niche: string;
  productTitle: string;
  targetAudience: string;
  isEmpireMode?: boolean;
}

export class BlueprintService {
  /**
   * Generates a design blueprint for Kittl.
   */
  async generateKittlBlueprint(req: BlueprintRequest) {
    console.log(`[BlueprintService] Generating Kittl blueprint for niche: ${req.niche}`);

    // 1. Generate Content via AI Design Architect
    const instructions = await aiScriptingService.generateDesignBlueprint({
      customerInquiry: req.targetAudience,
      businessNiche: req.niche,
      userGoal: "Provide a detailed manual design guide that uses free-tier assets and ensures uniqueness.",
      productName: req.productTitle,
    });

    let antiCopycatWarning = "";

    // 2. Empire Mode: Visual Validation
    if (req.isEmpireMode) {
      try {
        const previewPath = await mediaService.createProductImage(req.productTitle, req.niche);
        const imageBuffer = await fs.readFile(previewPath);
        
        await originalityService.validateUniqueness(imageBuffer, 'kittl');
        console.log("[BlueprintService] Empire Mode: Visual uniqueness validated.");
      } catch (error: any) {
        console.warn(`[BlueprintService] Empire Mode Validation failed: ${error.message}`);
        antiCopycatWarning = `\n\n**IMPORTANT: Empire Mode Warning**\n${error.message}\nPlease apply a "Visual Pivot" by changing the layout or primary graphic significantly.`;
      }
    }

    const fullInstructions = instructions + antiCopycatWarning;

    const blueprintId = uuidv4();
    await db.insert(blueprints).values({
      id: blueprintId,
      userId: req.userId,
      platform: 'kittl',
      title: req.productTitle,
      description: `Kittl Blueprint for ${req.niche}`,
      instructions: fullInstructions,
      assets: {
        copy: [req.productTitle, "Premium Quality", "Established 2024"],
        suggestions: ["Vintage", "Minimalist", "Free-tier focus"],
        empireModeValidated: req.isEmpireMode
      },
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return { id: blueprintId, instructions: fullInstructions, platform: 'kittl' };
  }

  /**
   * Generates a video blueprint for CapCut.
   */
  async generateCapCutBlueprint(req: BlueprintRequest) {
    console.log(`[BlueprintService] Generating CapCut blueprint for niche: ${req.niche}`);

    // Using the design architect for video blueprints too, but with video-specific goal
    const instructions = await aiScriptingService.generateDesignBlueprint({
      customerInquiry: req.targetAudience,
      businessNiche: req.niche,
      userGoal: "Provide a detailed video editing blueprint for CapCut, prioritizing free features and high engagement structure.",
      productName: req.productTitle,
    });

    const blueprintId = uuidv4();
    await db.insert(blueprints).values({
      id: blueprintId,
      userId: req.userId,
      platform: 'capcut',
      title: req.productTitle,
      description: `CapCut Blueprint for ${req.niche}`,
      instructions,
      assets: {
        script: ["Hook: ...", "Body: ...", "CTA: ..."],
        modifiers: ["Fast-paced", "High-contrast"]
      },
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return { id: blueprintId, instructions, platform: 'capcut' };
  }
}

export const blueprintService = new BlueprintService();
