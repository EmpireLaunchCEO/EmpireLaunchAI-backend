import { Request, Response } from 'express';
import { reasoningEngine } from '../services/reasoningEngine.js';
import { DnaVaultService } from '../utils/dnaVaultService.js';

const dnaVault = new DnaVaultService();

const CREATIVE_DIRECTOR_PROMPT = `You are the EmpireLaunch AI Creative Director — a conversational design partner that helps users create stunning visual content.

YOUR JOB:
1. Ask clarifying questions one at a time to build a complete creative brief. Cover:
   - Visual style (minimalist, bold, elegant, playful, vintage, futuristic, etc.)
   - Color palette / mood (warm, cool, vibrant, muted, dark, pastel, etc.)
   - Typography preferences (serif, sans-serif, script, display, hand-drawn, etc.)
   - Composition / layout (centered, asymmetric, grid, full-bleed, etc.)
   - Pacing / mood for video (fast, slow, dramatic, calm, energetic, etc.)
   - Content purpose (social media, Etsy listing, product showcase, brand video, etc.)

2. If the user doesn't answer a question explicitly, infer the best default from context.
   Never ask a question that's already been answered by context or previous messages.

3. When you have enough information to create a complete creative brief, respond with:
   [GENERATE]
   finalPrompt: "A detailed, production-ready prompt for the AI generation engine..."
   
   Then list selectedElements as a JSON block.

4. Keep responses conversational and friendly. Guide the user toward the best creative outcome.

RULES:
- Ask at most ONE question per response
- If the user says something like "just make something" or "surprise me", pick creative defaults
- The [GENERATE] tag signals you're done asking questions — only use it when you truly have enough info
- Never include [GENERATE] in the same message as a question`;

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface VaultElements {
  typography: any | null;
  palette: any | null;
  layout: any | null;
  background: any | null;
}

async function queryVaultForElements(niche: string): Promise<VaultElements> {
  const [typography, palette, layout, background] = await Promise.all([
    dnaVault.searchStrands('typography ' + niche, 3),
    dnaVault.searchStrands('palette ' + niche, 3),
    dnaVault.searchStrands('layout ' + niche, 3),
    dnaVault.searchStrands('background ' + niche, 3),
  ]);

  return {
    typography: typography[0] || null,
    palette: palette[0] || null,
    layout: layout[0] || null,
    background: background[0] || null,
  };
}

function buildVaultContext(elements: VaultElements): string {
  const parts: string[] = [];
  if (elements.typography) parts.push(`Typography inspiration: ${JSON.stringify(elements.typography.manifest)}`);
  if (elements.palette) parts.push(`Color palette inspiration: ${JSON.stringify(elements.palette.manifest)}`);
  if (elements.layout) parts.push(`Layout inspiration: ${JSON.stringify(elements.layout.manifest)}`);
  if (elements.background) parts.push(`Background inspiration: ${JSON.stringify(elements.background.manifest)}`);
  return parts.length ? '\n\nDNA Vault References:\n' + parts.join('\n') : '';
}

function parseGenerateResponse(text: string): {
  isGenerate: boolean;
  assistantMessage: string;
  finalPrompt?: string;
  selectedElements?: VaultElements;
} {
  const generateIndex = text.indexOf('[GENERATE]');
  if (generateIndex === -1) {
    return { isGenerate: false, assistantMessage: text };
  }

  // Extract the conversational part before [GENERATE]
  const beforeGenerate = text.substring(0, generateIndex).trim();
  const afterGenerate = text.substring(generateIndex + '[GENERATE]'.length);

  // Try to extract finalPrompt from the block after [GENERATE]
  const promptMatch = afterGenerate.match(/finalPrompt:\s*"([^"]+)"/);
  const finalPrompt = promptMatch ? promptMatch[1] : afterGenerate.trim();

  return {
    isGenerate: true,
    assistantMessage: beforeGenerate || "I've gathered enough to create your design. Here's the creative brief:",
    finalPrompt,
  };
}

export const conversationalChat = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { message, conversationHistory = [], brandContext = {} } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Build conversation context for Gemini
    const history = conversationHistory as ConversationMessage[];
    const niche = brandContext.niche || '';

    // Query DNA vault for matching elements
    const vaultElements = niche ? await queryVaultForElements(niche) : {
      typography: null, palette: null, layout: null, background: null,
    };

    const vaultContext = buildVaultContext(vaultElements);

    // Build user message with history
    const historyBlock = history.length > 0
      ? 'CONVERSATION HISTORY:\n' + history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n') + '\n\n'
      : '';

    const userMessage = `${historyBlock}USER MESSAGE: ${message}${vaultContext}\n\nRemember: ask at most one clarifying question. If you have enough info, respond with [GENERATE] and the finalPrompt.`;

    // Call Gemini
    const rawResponse = await reasoningEngine.reason(
      CREATIVE_DIRECTOR_PROMPT,
      userMessage
    );

    // Parse the response for [GENERATE] tag
    const parsed = parseGenerateResponse(rawResponse);

    if (parsed.isGenerate) {
      // Anti-duplication: check vault stats and add uniqueness constraint
      const vaultStats = await dnaVault.getVaultStats();
      const uniquenessNote = vaultStats.totalCount > 0
        ? '\n\nCreate something completely original. Do not replicate any existing design. Avoid common patterns.'
        : '';

      return res.json({
        status: 'success',
        readyToGenerate: true,
        assistantMessage: parsed.assistantMessage,
        finalPrompt: (parsed.finalPrompt || '') + uniquenessNote,
        selectedElements: vaultElements,
        conversationHistory: [
          ...history,
          { role: 'user', content: message },
          { role: 'assistant', content: rawResponse },
        ],
      });
    }

    // Conversation continuing — return the assistant's question
    res.json({
      status: 'success',
      readyToGenerate: false,
      assistantMessage: rawResponse,
      conversationHistory: [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: rawResponse },
      ],
    });
  } catch (error: any) {
    console.error('[ConversationalStudio] Error:', error);
    res.status(500).json({ error: error.message });
  }
};
