import { reasoningEngine } from './reasoningEngine.js';

export interface IntelTrendsParams {
  niche?: string;
  angle?: string;
  targetCustomers?: string;
  businessGoals?: string;
}

export interface IntelTrendsResult {
  trendingThemes: string[];
  seasonalOpportunities: string[];
  hotSellingItems: string[];
  lowCompetitionItems: string[];
  contentIdeas: string[];
}

const DEFAULT_EMPTY_RESULT: IntelTrendsResult = {
  trendingThemes: [],
  seasonalOpportunities: [],
  hotSellingItems: [],
  lowCompetitionItems: [],
  contentIdeas: [],
};

function buildIntelPrompt(params: IntelTrendsParams): string {
  const context = [];
  if (params.niche) context.push(`Business niche: ${params.niche}`);
  if (params.angle) context.push(`Business angle/approach: ${params.angle}`);
  if (params.targetCustomers) context.push(`Target customers: ${params.targetCustomers}`);
  if (params.businessGoals) context.push(`Business goals: ${params.businessGoals}`);

  return `You are a real-time market intelligence analyst. Search the web for CURRENT, up-to-date trends, data, and opportunities. Do NOT use stale training data — find what is actually trending RIGHT NOW on platforms like Etsy, TikTok, Instagram, Pinterest, Amazon, and Google Trends.

${context.join('\n')}

Based on your web research, return a single valid JSON object (no markdown, no code fences) with exactly these five keys. Each key must be an array of strings:

{
  "trendingThemes": ["exact trending theme 1", "exact trending theme 2", ...],
  "seasonalOpportunities": ["upcoming seasonal event or holiday opportunity 1", ...],
  "hotSellingItems": ["specific hot-selling product or content type 1", ...],
  "lowCompetitionItems": ["specific product/content idea with low competition and good profit 1", ...],
  "contentIdeas": ["specific content or design idea relevant to the niche 1", ...]
}

RULES:
- Every array must have at least 3 items. Aim for 5-7 items each.
- Each item must be specific and actionable, not generic.
- Focus on what is ACTUALLY selling/performing right now based on your web search.
- Include numbers, stats, or platform names where relevant.
- Return ONLY the JSON object — no explanation, no markdown formatting.`;
}

async function callGeminiWithGrounding(prompt: string): Promise<string> {
  const geminiKey = process.env.GOOGLE_STUDIO_API_KEY || process.env.GOOGLE_API_KEY;
  if (!geminiKey) {
    throw new Error('GOOGLE_API_KEY not configured');
  }

  // Try with Google Search grounding tool first
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: prompt }] }
      ],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
    })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error: ${response.status} ${errorBody}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini returned empty response');
  }
  return text;
}

function parseIntelResponse(raw: string): IntelTrendsResult {
  // Strip any markdown code fences
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      trendingThemes: Array.isArray(parsed.trendingThemes) ? parsed.trendingThemes : [],
      seasonalOpportunities: Array.isArray(parsed.seasonalOpportunities) ? parsed.seasonalOpportunities : [],
      hotSellingItems: Array.isArray(parsed.hotSellingItems) ? parsed.hotSellingItems : [],
      lowCompetitionItems: Array.isArray(parsed.lowCompetitionItems) ? parsed.lowCompetitionItems : [],
      contentIdeas: Array.isArray(parsed.contentIdeas) ? parsed.contentIdeas : [],
    };
  } catch {
    // If JSON parse fails, try to extract arrays with regex as fallback
    console.warn('[IntelService] Failed to parse JSON response, attempting regex extraction');
    return extractArraysFromText(cleaned);
  }
}

function extractArraysFromText(text: string): IntelTrendsResult {
  const extract = (key: string): string[] => {
    const regex = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`, 'i');
    const match = text.match(regex);
    if (!match || !match[1]) return [];
    return match[1]
      .split(',')
      .map(s => s.replace(/^["'\s]+|["'\s]+$/g, '').trim())
      .filter(Boolean);
  };

  return {
    trendingThemes: extract('trendingThemes'),
    seasonalOpportunities: extract('seasonalOpportunities'),
    hotSellingItems: extract('hotSellingItems'),
    lowCompetitionItems: extract('lowCompetitionItems'),
    contentIdeas: extract('contentIdeas'),
  };
}

export class IntelService {
  /**
   * Researches current market trends for the given business parameters.
   * Uses Gemini with Google Search grounding for real-time web data.
   * Falls back to standard reasoning if grounding is unavailable.
   */
  async researchTrends(params: IntelTrendsParams): Promise<IntelTrendsResult> {
    const prompt = buildIntelPrompt(params);

    try {
      // Try with Google Search grounding first
      const raw = await callGeminiWithGrounding(prompt);
      return parseIntelResponse(raw);
    } catch (err: any) {
      console.warn('[IntelService] Grounded search failed, falling back to standard reasoning:', err.message);
    }

    // Fallback: use standard reasoning without grounding
    try {
      const raw = await reasoningEngine.reason(buildIntelPrompt(params), {
        temperature: 0.3,
        maxTokens: 2048,
      });
      return parseIntelResponse(raw);
    } catch (err: any) {
      console.error('[IntelService] All AI calls failed:', err.message);
      return DEFAULT_EMPTY_RESULT;
    }
  }
}

export const intelService = new IntelService();
