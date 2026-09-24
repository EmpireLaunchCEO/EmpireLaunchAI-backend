import type { StyleDNA, DesignReasoningResult } from './empireStudioService.js';

/**
 * designDnaPure — pure helpers for the vault-DNA design foundation bridge.
 * Kept dependency-free (type-only imports) so the unit tests run without
 * loading the whole langchain/canva/queue dependency graph.
 */

/** Normalize a goal archetype (SELLER/CONTENT_CREATOR) or free string to the
 *  reasoner's vocabulary ('creator' = product design, 'catalyst' = growth). */
export function normalizeArchetype(raw?: string | null): string {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'seller') return 'creator';
  if (v === 'content_creator' || v === 'catalyst') return 'catalyst';
  return 'creator';
}

/** Extract the niche from a goals.description ("Empire Niche: X." marker), else the title. */
export function extractNicheFromGoal(goal: { title?: string | null; description?: string | null } | undefined): string {
  if (!goal) return '';
  if (goal.description) {
    const m = String(goal.description).match(/Empire Niche:\s*(.*?)(?:\.|$)/i);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return goal.title || '';
}

/** Build the Visual Pivot directive appended to a re-render prompt when the
 *  anti-copycat gate flags the first render as too similar (owner hard rule:
 *  "Can't copycat images... every design is to be unique"). Mirrors the Visual
 *  Pivot strategies in anti_copycat_logic.md §4: inversion (mirror layout),
 *  palette shift (~120° on the color wheel), abstraction (photo → vector). */
export function buildVisualPivotDirective(reasoning?: string): string {
  return [
    'UNIQUENESS PIVOT — the previous design is too similar to existing work. Rebuild it to be unmistakably unique:',
    '1. Mirror the layout — move focal elements to the opposite side.',
    '2. Shift the color palette ~120 degrees on the color wheel from the previous palette.',
    '3. Replace photographic elements with vector illustrations (or vice versa).',
    'Keep the same message, niche and DNA intent, but produce a NEW composition.',
    reasoning ? `Anti-copycat note: ${reasoning}` : '',
  ].filter(Boolean).join('\n');
}

/** Build the DNA directive appended to an image prompt so GPT Image follows the client's vault DNA. */
export function buildDnaDirective(styleDna: StyleDNA, reason: DesignReasoningResult): string {
  const lines: string[] = [
    'DESIGN FOUNDATION — use this harvested brand DNA as the base for the design:',
    `Colors: ${styleDna.colors.join(', ')}`,
    `Fonts: ${styleDna.fonts.join(', ')}`,
    `Tone: ${styleDna.tone} (${styleDna.pacing} pacing)`,
    `Style direction: ${reason.templateStyle}`,
  ];
  if (reason.suggestedHooks && reason.suggestedHooks.length) {
    lines.push(`Hook/CTA direction: ${reason.suggestedHooks.slice(0, 2).join(' | ')}`);
  }
  return lines.join('\n');
}