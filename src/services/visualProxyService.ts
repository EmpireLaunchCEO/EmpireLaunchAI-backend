import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { resolveModelForUser } from '../utils/resolveModel.js';
import { DnaStrand } from './dnaVaultService.js';
import { webSocketService } from './websocketService.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

export interface VisualSummary {
  snapshotId: string;
  primaryVibe: string;
  colorScheme: string;
  typographyMood: string;
  designPersonality: string;
  bestFor: string[];
  synthesisPrompt: string;
  previewCss: {
    backgroundGradient: string;
    fontFamily: string;
    accentColor: string;
    textColor: string;
    cardStyle: 'minimal' | 'vibrant' | 'warm' | 'dark' | 'playful';
    vibeElement: string;
  };
  sourceStrandIds: string[];
  generatedAt: string;
}

export class VisualProxyService {
  async summarizeStrand(userId: string, strand: DnaStrand): Promise<VisualSummary> {
    const snapshotId = uuidv4();
    const synthesis = await this.synthesizeFromDna(userId, strand);
    const previewCss = this.buildPreviewCss(strand.manifest);
    return {
      snapshotId,
      primaryVibe: synthesis.primaryVibe,
      colorScheme: synthesis.colorScheme,
      typographyMood: synthesis.typographyMood,
      designPersonality: synthesis.designPersonality,
      bestFor: synthesis.bestFor,
      synthesisPrompt: synthesis.synthesisPrompt,
      previewCss,
      sourceStrandIds: strand.id ? [strand.id] : [],
      generatedAt: new Date().toISOString(),
    };
  }

  async summarizeMultiple(userId: string, strands: DnaStrand[]): Promise<VisualSummary> {
    if (strands.length === 0) throw new Error('No strands');
    if (strands.length === 1) return this.summarizeStrand(userId, strands[0]);
    const merged = await this.mergeAndSynthesize(userId, strands);
    const previewCss = this.buildPreviewCss(strands[0].manifest);
    return {
      snapshotId: uuidv4(),
      primaryVibe: merged.primaryVibe,
      colorScheme: merged.colorScheme,
      typographyMood: merged.typographyMood,
      designPersonality: merged.designPersonality,
      bestFor: merged.bestFor,
      synthesisPrompt: merged.synthesisPrompt,
      previewCss,
      sourceStrandIds: strands.map(s => s.id).filter(Boolean) as string[],
      generatedAt: new Date().toISOString(),
    };
  }

  private async synthesizeFromDna(userId: string, strand: DnaStrand) {
    try {
      const model = await resolveModelForUser(userId);
      const template = `Synthesize vibe from DNA: {manifest}. Return JSON: primaryVibe, colorScheme, typographyMood, designPersonality, bestFor, synthesisPrompt.`;
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      return await chain.invoke({ manifest: JSON.stringify(strand.manifest) }) as any;
    } catch (e) {
      return { primaryVibe: 'Synthesized', colorScheme: 'Neutral', typographyMood: 'Standard', designPersonality: 'Clean', bestFor: [], synthesisPrompt: '' };
    }
  }

  private async mergeAndSynthesize(userId: string, strands: DnaStrand[]) {
    try {
      const model = await resolveModelForUser(userId);
      const template = `Merge DNA: {strands}. Return JSON: primaryVibe, colorScheme, typographyMood, designPersonality, bestFor, synthesisPrompt.`;
      const prompt = PromptTemplate.fromTemplate(template);
      const chain = RunnableSequence.from([prompt, model, new JsonOutputParser()]);
      return await chain.invoke({ strands: JSON.stringify(strands.map(s => s.manifest)) }) as any;
    } catch (e) {
      return { primaryVibe: 'Merged', colorScheme: 'Mixed', typographyMood: 'Balanced', designPersonality: 'Unified', bestFor: [], synthesisPrompt: '' };
    }
  }

  private buildPreviewCss(manifest: any): VisualSummary['previewCss'] {
    const primary = manifest.primary || '#1a1a2e';
    const secondary = manifest.secondary || '#e94560';
    return {
      backgroundGradient: `linear-gradient(135deg, ${primary}, ${secondary})`,
      fontFamily: 'Inter',
      accentColor: '#0f3460',
      textColor: '#ffffff',
      cardStyle: 'minimal',
      vibeElement: '<div></div>',
    };
  }
}

export const visualProxyService = new VisualProxyService();
