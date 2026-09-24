import { db, schema } from '../db/index.js';
import { eq, desc } from 'drizzle-orm';
import { empireStudioService, StyleDNA, DesignReasoningResult } from './empireStudioService.js';
import { normalizeArchetype, extractNicheFromGoal, buildDnaDirective } from './designDnaPure.js';

export { normalizeArchetype, extractNicheFromGoal, buildDnaDirective };

/**
 * designDnaBridge — shared DNA-foundation resolution for the DESIGN GENERATION path.
 *
 * The owner requirement: harvested Canva DNA (stored in the Universal Vault via
 * dnaVaultService) must be the BASE FOUNDATION for every client design. The
 * Studio master-asset path (empireStudioService.createAndDistribute) already
 * resolves StyleDNA from the Vault; the design generation path (approval
 * type=design → studio image_creation/image_editing → GPT Image) did NOT.
 *
 * This bridge lets both the approval controller and the studio route resolve the
 * client's DNA the same way the Studio path does, WITHOUT requiring the client to
 * send niche/angle — the backend derives them from the platform's own records
 * (the user's goals/brand rows), per the owner directive.
 */

/** Resolve the client's niche + archetype from platform records (goals/brand rows).
 *  Returns '' niche when nothing is known so callers can skip DNA injection. */
export async function resolveClientContext(
  userId: string,
  brandId?: string | null,
  explicitNiche?: string | null,
  explicitArchetype?: string | null
): Promise<{ niche: string; angle: string; archetype: string }> {
  // 1. Explicit params win (frontend may still send them).
  if (explicitNiche && explicitNiche.trim()) {
    return {
      niche: explicitNiche.trim(),
      angle: '',
      archetype: normalizeArchetype(explicitArchetype),
    };
  }
  // 2. brandId → goals row (the caller already fetched it in most paths).
  let goal: any;
  if (brandId) {
    try {
      const [row] = await db.select().from(schema.goals).where(eq(schema.goals.id, brandId)).limit(1);
      goal = row;
    } catch (e) {
      console.warn('[DesignDnaBridge] brandId lookup failed:', (e as Error).message);
    }
  }
  // 3. Fall back to the user's most recent goal (their active brand). Only
  //    meaningful for real UUID users — device UUIDs have no goals row, so
  //    skip the FK query to avoid a PG type error.
  if (!goal && isUuidLike(userId)) {
    try {
      const rows = await db.select()
        .from(schema.goals)
        .where(eq(schema.goals.userId, userId))
        .orderBy(desc(schema.goals.createdAt))
        .limit(1);
      goal = rows[0];
    } catch (e) {
      // best-effort — DNA injection must never block design generation
      console.warn('[DesignDnaBridge] goal lookup failed (best-effort skip):', (e as Error).message);
    }
  }
  const niche = extractNicheFromGoal(goal);
  const archetype = goal?.archetype ? normalizeArchetype(goal.archetype) : normalizeArchetype(explicitArchetype);
  return { niche, angle: '', archetype };
}

/** Minimal UUID check so goals FK lookups don't 500 on un-UUID device ids. */
function isUuidLike(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export interface DnaFoundation {
  styleDna: StyleDNA;
  designReasoning: DesignReasoningResult;
  directive: string;
  usedVault: boolean;
}

/**
 * Best-effort resolve of the client's harvested DNA for a design generation.
 * Returns null when no niche is known (or resolution fails) — NEVER throws,
 * so design generation always proceeds even without vault input.
 */
export async function tryResolveDesignDna(
  userId: string,
  opts: {
    brandId?: string | null;
    niche?: string | null;
    angle?: string | null;
    archetype?: string | null;
  } = {}
): Promise<DnaFoundation | null> {
  try {
    const ctx = await resolveClientContext(userId, opts.brandId, opts.niche, opts.archetype);
    if (!ctx.niche) return null;
    const { styleDna, designReasoning } = await empireStudioService.resolveClientDesignFoundation(
      userId,
      ctx.niche,
      opts.angle || ctx.angle,
      ctx.archetype
    );
    const directive = buildDnaDirective(styleDna, designReasoning);
    const usedVault = Array.isArray(designReasoning.vaultStrandsUsed) && designReasoning.vaultStrandsUsed.length > 0;
    return { styleDna, designReasoning, directive, usedVault };
  } catch (e) {
    console.warn('[DesignDnaBridge] DNA resolution failed (falling back to prompt-only):', (e as Error).message);
    return null;
  }
}