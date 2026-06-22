import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { resolveModelForUser } from '../utils/resolveModel.js';
import { DnaStrand } from './dnaVaultService.js';
import { webSocketService } from './websocketService.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

/**
 * ZERO-SOURCE-IMAGE Visual Proxy Service.
 * 
 * RULE: NEVER reference, display, screenshot, or derive from actual competitor
 * product images, Etsy listings, TikTok videos, or any other source platform.
 * 
 * All previews are 100% SYNTHESIZED from DNA attributes only:
 * - Colors → gradient + vibe name
 * - Fonts → typography feel description
 * - Layout params → an AI image generation prompt for a UNIQUE mockup
 * 
 * This ensures ZERO copyright risk while giving users a visual "feel"
 * for the harvested trend.
 */
export interface VisualSummary {
  /** Unique ID for this visual snapshot */
  snapshotId: string;

  /** Human-readable vibe/mood (e.g. "Vintage Rose", "Modern Monochrome") */
  primaryVibe: string;

  /** Human-readable color scheme description */
  colorScheme: string;

  /** Human-readable typography description */
  typographyMood: string;

  /** Overall design personality in plain language */
  designPersonality: string;

  /** Suggested use case / where this DNA works best */
  bestFor: string[];

  /**
   * AI image generation prompt for creating a UNIQUE synthesized mockup.
   * This prompt describes a generic, beautiful design scene using the DNA's
   * colors, fonts, and layout parameters — NOT a replica of any real product.
   * 
   * The frontend can use this with DALL-E, Stable Diffusion, Midjourney,
   * or any image API to generate the actual preview image.
   * 
   * Example output:
   * "A minimalist sage green and cream mockup with elegant serif typography.
   *  Clean lines, soft natural lighting, subtle shadow depth. 
   *  Digital product presentation on a marble surface.
   *  No logos, no text content, no identifiable products."
   */
  synthesisPrompt: string;

  /**
   * FUTURE: URL to a server-generated mockup image.
   * Null for now — the frontend should use synthesisPrompt + its own image API.
   * If implemented, this MUST point to an AI-generated image, never a source product.
   */
  mockupUrl?: string;

  /** CSS template data — frontend can render this directly */
  previewCss: {
    backgroundGradient: string;
    fontFamily: string;
    accentColor: string;
    textColor: string;
    cardStyle: 'minimal' | 'vibrant' | 'warm' | 'dark' | 'playful';
    /** HTML snippet showing the synthesized vibe — font + colors only, no product imagery */
    vibeElement: string;
  };

  /** The original strand IDs that contributed (DNA source tracking, NOT for display) */
  sourceStrandIds: string[];

  /** When this snapshot was generated */
  generatedAt: string;
}

export class VisualProxyService {

  /**
   * Generate a zero-source-image VisualSummary from a single DNA strand.
   */
  async summarizeStrand(
    userId: string,
    strand: DnaStrand,
  ): Promise<VisualSummary> {
    const snapshotId = uuidv4();
    const manifest = strand.manifest;

    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🎨 Visual Proxy: Synthesizing preview from DNA (${strand.category}/${strand.subCategory})...`
    });

    // Step 1: AI translation from manifest → human-readable vibe + image prompt
    const synthesis = await this.synthesizeFromDna(userId, strand);

    // Step 2: Generate CSS preview data from the manifest (no images)
    const previewCss = this.buildPreviewCss(manifest, strand.category);

    // Step 3: Build the complete VisualSummary — NO source platform references
    const summary: VisualSummary = {
      snapshotId,
      primaryVibe: synthesis.primaryVibe || this.inferVibeFromManifest(manifest, strand.category),
      colorScheme: synthesis.colorScheme || this.describeColors(manifest),
      typographyMood: synthesis.typographyMood || this.describeTypography(manifest),
      designPersonality: synthesis.designPersonality || 'Synthesized design pattern',
      bestFor: synthesis.bestFor || [strand.category],
      synthesisPrompt: synthesis.synthesisPrompt || this.buildFallbackSynthesisPrompt(manifest),
      previewCss,
      sourceStrandIds: strand.id ? [strand.id] : [],
      generatedAt: new Date().toISOString(),
    };

    webSocketService.notifyUser(userId, 'ai-log', {
      message: `✅ Visual Proxy complete: "${summary.primaryVibe}" — use synthesisPrompt to generate a unique preview image.`
    });

    return summary;
  }

  /**
   * Batch summarize multiple strands into one VisualSummary.
   */
  async summarizeMultiple(
    userId: string,
    strands: DnaStrand[],
  ): Promise<VisualSummary> {
    if (strands.length === 0) {
      throw new Error('No strands provided for visual summarization');
    }
    if (strands.length === 1) {
      return this.summarizeStrand(userId, strands[0]);
    }

    const snapshotId = uuidv4();

    webSocketService.notifyUser(userId, 'ai-log', {
      message: `🎨 Visual Proxy: Synthesizing ${strands.length} DNA strands into unified preview...`
    });

    const merged = await this.mergeAndSynthesize(userId, strands);
    const previewCss = this.buildPreviewCss(strands[0].manifest, strands[0].category);

    const summary: VisualSummary = {
      snapshotId,
      primaryVibe: merged.primaryVibe,
      colorScheme: merged.colorScheme,
      typographyMood: merged.typographyMood,
      designPersonality: merged.designPersonality,
      bestFor: merged.bestFor,
      synthesisPrompt: merged.synthesisPrompt || 'A harmonious blend of multiple design elements',
      previewCss,
      sourceStrandIds: strands.map(s => s.id).filter(Boolean) as string[],
      generatedAt: new Date().toISOString(),
    };

    return summary;
  }

  // ─── AI SYNTHESIS (Zero-Source-Image) ─────────────────────────────────

  /**
   * Uses AI to synthesize human-readable descriptions + image generation prompt
   * from DNA parameters. NEVER references source products or platforms.
   */
  private async synthesizeFromDna(
    userId: string,
    strand: DnaStrand,
  ): Promise<{
    primaryVibe: string;
    colorScheme: string;
    typographyMood: string;
    designPersonality: string;
    bestFor: string[];
    synthesisPrompt: string;
  }> {
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key') {
      try {
        const model = await resolveModelForUser(userId);

        const template = `
          You are a Visual Design Synthesizer. Your job is to take RAW DESIGN PARAMETERS
          (color hex codes, font names, layout rules) and generate:

          1. A human-readable vibe description
          2. An IMAGE GENERATION PROMPT for creating a UNIQUE, ORIGINAL mockup
             that captures the FEELING of these parameters without reproducing any
             existing product or platform content.

          CRITICAL RULES (you MUST follow):
          - NEVER reference any specific product, brand, or platform
          - NEVER describe a competitor's product or listing
          - NEVER use phrases like "similar to Etsy best seller" or "TikTok trending"
          - The image prompt must describe a GENERIC scene using these design tokens
          - Think "a beautiful product photography set" not "a copy of an existing item"

          DNA Parameters:
          - Category: {category}
          - SubCategory: {subCategory}
          - Colors used: {colors}
          - Fonts used: {fonts}
          - Manifest: {manifest}

          Return ONLY valid JSON:
          - primaryVibe: string (evocative name like "Vintage Rose", no product references)
          - colorScheme: string (natural language color description, e.g. "Warm pastels with deep burgundy")
          - typographyMood: string (font feel, e.g. "Elegant serif headlines with airy sans-serif body")
          - designPersonality: string (one sentence about the design energy)
          - bestFor: string[] (2-3 use cases, e.g. ["Social media graphics", "Product thumbnails"])
          - synthesisPrompt: string (an image generation prompt for creating an ORIGINAL mockup using these design tokens)
        `;

        const prompt = PromptTemplate.fromTemplate(template);
        const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);

        const colors = this.extractColors(strand.manifest);
        const fonts = this.extractFonts(strand.manifest);

        const result = await chain.invoke({
          category: strand.category,
          subCategory: strand.subCategory || 'general',
          colors: colors.length > 0 ? colors.join(', ') : 'warm neutrals',
          fonts: fonts.length > 0 ? fonts.join(', ') : 'Inter',
          manifest: JSON.stringify(strand.manifest, null, 2),
        }) as any;

        return {
          primaryVibe: result.primaryVibe || 'Synthesized Design',
          colorScheme: result.colorScheme || this.describeColors(strand.manifest),
          typographyMood: result.typographyMood || this.describeTypography(strand.manifest),
          designPersonality: result.designPersonality || 'Original design synthesis',
          bestFor: result.bestFor || [strand.category],
          synthesisPrompt: result.synthesisPrompt || this.buildFallbackSynthesisPrompt(strand.manifest),
        };
      } catch (e) {
        console.warn('[VisualProxy] AI synthesis failed:', (e as Error).message);
      }
    }

    // Fallback: rule-based extraction from manifest
    return {
      primaryVibe: this.inferVibeFromManifest(strand.manifest, strand.category),
      colorScheme: this.describeColors(strand.manifest),
      typographyMood: this.describeTypography(strand.manifest),
      designPersonality: `Synthesized ${strand.subCategory || 'professional'} design`,
      bestFor: [strand.category],
      synthesisPrompt: this.buildFallbackSynthesisPrompt(strand.manifest),
    };
  }

  /**
   * AI merge + synthesis for multiple strands.
   */
  private async mergeAndSynthesize(
    userId: string,
    strands: DnaStrand[],
  ): Promise<{
    primaryVibe: string;
    colorScheme: string;
    typographyMood: string;
    designPersonality: string;
    bestFor: string[];
    synthesisPrompt: string;
  }> {
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key') {
      try {
        const model = await resolveModelForUser(userId);

        const template = `
          You are a Visual Design Synthesizer. Combine the following design DNA strands
          into ONE coherent visual preview. 

          CRITICAL: Never reference specific products, brands, or platforms.
          Describe the SYNTHESIZED FEELING, not a replica of anything existing.

          Strands:
          {strands}

          Return ONLY valid JSON:
          - primaryVibe: string (unified name)
          - colorScheme: string
          - typographyMood: string
          - designPersonality: string
          - bestFor: string[] (2-3 use cases)
          - synthesisPrompt: string (image prompt for a UNIQUE mockup)
        `;

        const prompt = PromptTemplate.fromTemplate(template);
        const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);

        const result = await chain.invoke({
          strands: JSON.stringify(strands.map(s => ({
            category: s.category,
            subCategory: s.subCategory,
            colors: this.extractColors(s.manifest),
            fonts: this.extractFonts(s.manifest),
            manifest: s.manifest,
            score: s.performanceScore,
          })), null, 2),
        }) as any;

        return {
          primaryVibe: result.primaryVibe || 'Synthesized Design',
          colorScheme: result.colorScheme || 'Multi-palette harmony',
          typographyMood: result.typographyMood || 'Balanced typography',
          designPersonality: result.designPersonality || 'Multi-strand synthesis',
          bestFor: result.bestFor || ['Cross-platform content'],
          synthesisPrompt: result.synthesisPrompt || this.buildFallbackSynthesisPrompt(strands[0].manifest),
        };
      } catch (e) {
        console.warn('[VisualProxy] Merge failed:', (e as Error).message);
      }
    }

    return this.synthesizeFromDna(userId, strands[0]);
  }

  // ─── CSS PREVIEW GENERATION (No images, just CSS) ──────────────────────

  /**
   * Builds CSS template data from a DNA manifest.
   * Zero images — just gradient, fonts, and a vibe element.
   */
  private buildPreviewCss(manifest: Record<string, any>, _category: string): VisualSummary['previewCss'] {
    const colors = this.extractColors(manifest);
    const primary = colors[0] || '#1a1a2e';
    const secondary = colors[1] || '#e94560';
    const accent = colors[2] || '#0f3460';

    const fontFamily = manifest.fontFamily || manifest.pairWith || this.extractFontFromTypography(manifest) || 'Inter';
    const cardStyle = this.inferCardStyle(primary, secondary);
    const backgroundGradient = `linear-gradient(135deg, ${primary}, ${secondary})`;

    // This is a STYLED TEXT DISPLAY, not a product image.
    // It shows the font + colors as a design preview, nothing more.
    const vibeElement = `<div style="font-family:'${fontFamily}',sans-serif;color:${this.getTextColor(primary)};background:${backgroundGradient};padding:32px;border-radius:16px;border:2px solid ${accent};text-align:center;font-size:18px;letter-spacing:0.5px">${fontFamily}<br><span style="font-size:12px;opacity:0.8">${primary} · ${secondary} · ${accent}</span></div>`;

    return {
      backgroundGradient,
      fontFamily,
      accentColor: accent,
      textColor: this.getTextColor(primary),
      cardStyle,
      vibeElement,
    };
  }

  // ─── FALLBACK SYNTHESIS PROMPT ──────────────────────────────────────────

  /**
   * Builds a text-to-image prompt from manifest data without referencing source products.
   * Used when AI synthesis is unavailable.
   */
  private buildFallbackSynthesisPrompt(manifest: Record<string, any>): string {
    const colors = this.extractColors(manifest);
    const fonts = this.extractFonts(manifest);
    const mood = manifest.mood || manifest.style || 'modern';

    const colorDesc = colors.length > 0
      ? colors.slice(0, 3).join(' and ')
      : 'warm neutral tones';

    const fontDesc = fonts.length > 0
      ? fonts[0]
      : 'clean sans-serif';

    return `A beautiful ${mood} product photography scene with ${colorDesc} color palette and ${fontDesc} typography. Clean background, soft natural lighting, elegant composition. No text, no logos, no identifiable products. Minimalist aesthetic, high contrast, professional grade. 4k, photorealistic, product photography style.`;
  }

  // ─── RULE-BASED FALLBACKS ────────────────────────────────────────────

  private inferVibeFromManifest(manifest: Record<string, any>, category: string): string {
    const mood = manifest.mood || manifest.style || '';
    const primary = manifest.primary || manifest.colorPalette?.[0] || '';

    // Color-based vibe inference — never references products
    if (mood.includes('soft') || mood.includes('pastel')) return 'Soft Pastel Elegance';
    if (mood.includes('dark') || mood.includes('bold')) return 'Bold Dark Statement';
    if (mood.includes('playful') || mood.includes('fun')) return 'Playful Pop';
    if (mood.includes('professional') || mood.includes('trust')) return 'Professional Trust';
    if (mood.includes('earth') || mood.includes('natural')) return 'Earthy Natural';
    if (mood.includes('luxury') || mood.includes('premium')) return 'Luxury Gold';
    if (primary.toLowerCase().includes('ff') || primary.includes('#FF')) return 'Vibrant Energy';

    // Category-based fallbacks
    if (category === 'palette') return 'Curated Palette';
    if (category === 'typography') return 'Typography First';
    if (category === 'layout') return 'Structured Layout';
    if (category === 'niche_pattern') return 'Niche Optimized';

    return 'Synthesized Design';
  }

  private describeColors(manifest: Record<string, any>): string {
    const colors = this.extractColors(manifest);
    if (colors.length === 0) return 'Neutral palette';

    const hexDesc = colors.slice(0, 3).join(', ');
    const warmCount = colors.filter(c => {
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      return r > 150 && g < 150;
    }).length;

    if (warmCount >= 2) return `Warm tones (${hexDesc})`;
    if (colors.every(c => parseInt(c.slice(1, 3), 16) < 100)) return `Dark palette (${hexDesc})`;
    return `${colors.length}-color scheme (${hexDesc})`;
  }

  private describeTypography(manifest: Record<string, any>): string {
    const font = manifest.fontFamily || manifest.pairWith || 'sans-serif';
    const weight = manifest.fontWeight || 400;
    const alignment = manifest.alignment || 'left';
    const weightDesc = weight >= 700 ? 'bold' : weight >= 500 ? 'medium' : 'light';
    return `${font} (${weightDesc}, ${alignment}-aligned)`;
  }

  private extractColors(manifest: Record<string, any>): string[] {
    const seen = new Set<string>();
    const colors: string[] = [];

    const add = (c: string) => {
      if (c && /^#[0-9A-Fa-f]{6}$/.test(c) && !seen.has(c)) {
        seen.add(c);
        colors.push(c);
      }
    };

    if (manifest.primary) add(manifest.primary);
    if (manifest.secondary) add(manifest.secondary);
    if (manifest.accent) add(manifest.accent);
    if (manifest.background) add(manifest.background);
    if (manifest.text) add(manifest.text);
    if (manifest.buttonColor) add(manifest.buttonColor);
    if (manifest.textOnButton) add(manifest.textOnButton);
    if (manifest.colorPalette && Array.isArray(manifest.colorPalette)) {
      for (const c of manifest.colorPalette) add(c);
    }
    if (manifest.colors && Array.isArray(manifest.colors)) {
      for (const c of manifest.colors) add(c);
    }
    if (manifest.backgroundColor) add(manifest.backgroundColor);

    return colors;
  }

  private extractFonts(manifest: Record<string, any>): string[] {
    const fonts: string[] = [];
    if (manifest.fontFamily && typeof manifest.fontFamily === 'string') fonts.push(manifest.fontFamily);
    if (manifest.pairWith && typeof manifest.pairWith === 'string') fonts.push(manifest.pairWith);
    if (manifest.typographySignature?.headline) fonts.push(manifest.typographySignature.headline);
    if (manifest.typographySignature?.body) fonts.push(manifest.typographySignature.body);
    if (manifest.fonts && Array.isArray(manifest.fonts)) {
      for (const f of manifest.fonts) {
        if (typeof f === 'string') fonts.push(f);
      }
    }
    return [...new Set(fonts)];
  }

  private extractFontFromTypography(manifest: Record<string, any>): string | null {
    const font = manifest.fontFamily || manifest.pairWith;
    if (font && typeof font === 'string') return font;
    if (manifest.typographySignature?.headline) return manifest.typographySignature.headline;
    return null;
  }

  private inferCardStyle(primary: string, _secondary: string): VisualSummary['previewCss']['cardStyle'] {
    const r1 = parseInt(primary.slice(1, 3), 16);
    const g1 = parseInt(primary.slice(3, 5), 16);
    const b1 = parseInt(primary.slice(5, 7), 16);
    const brightness = (r1 * 299 + g1 * 587 + b1 * 114) / 1000;

    if (brightness < 80) return 'dark';
    if (brightness > 220) return 'minimal';
    if (r1 > 200 && g1 < 100) return 'vibrant';
    if (r1 > 150 && g1 > 100 && b1 < 100) return 'warm';
    return 'playful';
  }

  private getTextColor(bgColor: string): string {
    const r = parseInt(bgColor.slice(1, 3), 16);
    const g = parseInt(bgColor.slice(3, 5), 16);
    const b = parseInt(bgColor.slice(5, 7), 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 150 ? '#1a1a2e' : '#ffffff';
  }
}

export const visualProxyService = new VisualProxyService();