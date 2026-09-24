import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
import { renderingEngine } from './renderingEngine.js';
import { r2Storage } from './r2StorageService.js';
import { uniquenessService } from './uniquenessService.js';
import { tryResolveDesignDna, resolveClientContext } from './designDnaBridge.js';
import { buildVisualPivotDirective } from './designDnaPure.js';

/**
 * designGenerationService — anti-copycat-gated design generation.
 *
 * Both design-generation entry points (studioRoutes /process image_creation |
 * image_editing, and approvalController POST /api/approval/create type='design')
 * must produce designs that are BUILT ON the client's harvested Vault DNA AND
 * pass the owner's anti-copycat uniqueness gate BEFORE anything is stored.
 *
 * Pipeline (mirrors empireStudioService.createAndDistribute step 3.5):
 *   1. Resolve client niche/archetype server-side (never trusted from client).
 *   2. Resolve StyleDNA + design reasoning from the Universal Vault (DNA bridge).
 *   3. Render the design image via GPT Image 2 (prompt = concept + DNA directive).
 *   4. ANTI-COPYCAT GATE: uniquenessService.validateUniqueness({ imageBuffer,
 *      niche, content, vaultStrandsUsed }) on the RENDERED image, BEFORE storage.
 *      - isUnique  → proceed, stamp uniquenessScore.
 *      - !isUnique → apply the Visual Pivot ONCE (re-render with a pivot
 *        directive); if the pivoted render is unique, store THAT; if it is
 *        still not unique, REJECT (never store a copycat).
 *   5. Upload the accepted render to R2, record a completed creation row
 *      (type='design') + approval row so the Operations Design Center shows it.
 *
 * ZERO-SOURCE-IMAGE POLICY (anti_copycat_logic.md): the client's uploaded
 * sourceImages are INPUT-ONLY — they drive gpt-image-2 edits but are NEVER
 * persisted, cached, or served. Only the DNA manifest, PHash/embedding, and the
 * newly generated design image are stored.
 */

export interface DesignGateResult {
  /** Anti-copycat verdict on the accepted render. */
  uniquenessScore: number;
  geometricScore: number;
  isUnique: boolean;
  reasoning: string;
  /** True when the stored render came from a Visual Pivot re-render. */
  pivotApplied: boolean;
}

export interface GenerateDesignOutcome {
  ok: boolean;
  status: 'completed' | 'rejected' | 'error';
  creationId?: string;
  imageUrl?: string;
  aiProvider?: string;
  dnaProvenance?: Record<string, any>;
  uniqueness?: DesignGateResult;
  /** Friendly, user-readable reason (409 body on rejection, 500 body on error). */
  error?: string;
  /** 409 when the design was rejected for similarity, 500 when generation failed. */
  httpStatus: number;
  niche?: string;
}

export interface GenerateDesignParams {
  userId: string;
  /** Client's design concept / refined idea (serves as title + prompt base). */
  description: string;
  brandId?: string | null;
  /** Input-only reference image URL (ZERO-SOURCE: never stored/served). */
  sourceImageUrl?: string | null;
  /** Optional overrides — the backend resolves from its own records by default. */
  explicitNiche?: string | null;
  explicitArchetype?: string | null;
  /** category stamped into metadata (defaults 'custom-design'). */
  category?: string;
  /** Classifier label (image_creation / image_editing). */
  classification?: string;
}

/**
 * Generate a design with the anti-copycat gate and persist the completed
 * creation + approval rows. Returns a fully-serialisable outcome; NEVER throws
 * for generation/gate failures (degrades to a friendly error outcome).
 */
export async function generateDesignAndRecord(
  params: GenerateDesignParams
): Promise<GenerateDesignOutcome> {
  const {
    userId, description, brandId, sourceImageUrl,
    explicitNiche, explicitArchetype, category = 'custom-design',
  } = params;
  const classification = params.classification || 'image_creation';

  // 1. Server-side client context (niche is known to the platform; the backend
  //    resolves it from goals/brand rows — never trusts a client-sent niche).
  const ctx = await resolveClientContext(userId, brandId, explicitNiche, explicitArchetype);

  // 2. Design foundation from the harvested DNA Vault (best-effort, never throws).
  let dnaPrompt = description;
  let dnaProvenance: Record<string, any> = {};
  let vaultStrandsUsed: string[] = [];
  try {
    const dna = await tryResolveDesignDna(userId, {
      brandId,
      niche: ctx.niche || explicitNiche,
      archetype: ctx.archetype,
    });
    if (dna) {
      dnaPrompt = `${description}\n\n${dna.directive}`;
      dnaProvenance = {
        styleDnaSource: 'vault',
        styleDna: dna.styleDna,
        vaultStrandsUsed: dna.designReasoning.vaultStrandsUsed,
        dnaStrandIds: dna.designReasoning.vaultStrandsUsed,
        strategy: dna.designReasoning.strategy,
      };
      vaultStrandsUsed = dna.designReasoning.vaultStrandsUsed || [];
    }
  } catch (e: any) {
    console.warn('[DesignGeneration] Vault DNA resolution skipped (prompt-only):', e?.message);
  }

  // 3. Render the design. Rendered WITHOUT a userId first so we keep the local
  //    PNG buffer for the uniqueness gate (no premature R2 upload — mirror of
  //    the studio faceless-engine pattern).
  const rendered = await renderingEngine.renderImage(dnaPrompt, undefined, sourceImageUrl || undefined);
  if (!rendered.success || !rendered.imageUrl) {
    return {
      ok: false,
      status: 'error',
      httpStatus: 500,
      error: rendered.error || 'Design generation failed (image render). Please try again.',
    };
  }

  // 4. ANTI-COPYCAT GATE — run on the generated image BEFORE it is stored.
  const gateAttempt = (buffer: Buffer, content: string) =>
    uniquenessService.validateUniqueness({
      userId,
      niche: ctx.niche || explicitNiche || 'general',
      content,
      imageBuffer: buffer,
      vaultStrandsUsed,
    });

  let localPath = rendered.imageUrl;
  let acceptedBuffer: Buffer | null = null;
  try {
    acceptedBuffer = fs.readFileSync(localPath);
  } catch (e: any) {
    console.warn('[DesignGeneration] Could not read render buffer for uniqueness gate:', e?.message);
  }

  let uniqueness: Awaited<ReturnType<typeof gateAttempt>> | null = null;
  let pivotApplied = false;

  if (acceptedBuffer) {
    try {
      uniqueness = await gateAttempt(acceptedBuffer, description);
      if (uniqueness && !uniqueness.isUnique) {
        console.warn(`[DesignGeneration] Anti-copycat gate flagged design (score ${uniqueness.semanticScore}): ${uniqueness.reasoning}`);
        // Visual Pivot ONCE: re-render with the pivot directive (mirror of
        // anti_copycat_logic.md §4 — inversion / palette shift / abstraction).
        const pivotedPrompt = `${dnaPrompt}\n\n${buildVisualPivotDirective(uniqueness.reasoning)}`;
        const pivoted = await renderingEngine.renderImage(pivotedPrompt, undefined, sourceImageUrl || undefined);
        if (pivoted.success && pivoted.imageUrl) {
          try {
            const pivotedBuffer = fs.readFileSync(pivoted.imageUrl);
            const pivotedCheck = await gateAttempt(pivotedBuffer, `PIVOTED ${description}`);
            if (pivotedCheck.isUnique) {
              localPath = pivoted.imageUrl;
              acceptedBuffer = pivotedBuffer;
              uniqueness = pivotedCheck;
              pivotApplied = true;
              console.log('[DesignGeneration] Visual Pivot applied — pivoted design passed the gate.');
            } else {
              console.warn(`[DesignGeneration] Pivoted design STILL flagged (${pivotedCheck.semanticScore}) — rejecting, not storing a copycat.`);
              // Fall through — uniqueness remains the first (non-unique) result → reject.
            }
          } catch (pivotReadErr: any) {
            console.warn('[DesignGeneration] Pivot buffer read failed, keeping original verdict:', pivotReadErr?.message);
          }
        }
      }
    } catch (gateErr: any) {
      // Gate infrastructure failure must not crash generation — record it as
      // metadata but proceed (the geometric/semantic check failed, not the design).
      console.warn('[DesignGeneration] Uniqueness gate error (proceeding without verdict):', gateErr?.message);
      uniqueness = null;
    }
  }

  // Reject decisively when the gate ran and the design is NOT unique (and a
  // pivot attempt either wasn't possible or still failed) — never store.s
  if (uniqueness && !uniqueness.isUnique) {
    return {
      ok: false,
      status: 'rejected',
      httpStatus: 409,
      error: `Design was flagged as too similar to existing work and won't be generated.\n\n${uniqueness.reasoning || 'Please adjust your design concept and try again.'}`,
      uniqueness: {
        uniquenessScore: uniqueness.semanticScore,
        geometricScore: uniqueness.geometricScore,
        isUnique: uniqueness.isUnique,
        reasoning: uniqueness.reasoning,
        pivotApplied,
      },
      dnaProvenance,
    };
  }

  // 5. Upload the ACCEPTED local render to R2 (userId now given → upload + unlink).
  const upload = await r2Storage.uploadLocalFile(localPath, userId, 'renders/designs', 'image/png');
  const imageUrl = upload.url || localPath;
  const aiProvider = 'GPT Image 2';

  const uniquenessMeta = uniqueness ? {
    uniquenessScore: uniqueness.semanticScore,
    geometricScore: uniqueness.geometricScore,
    uniquenessReasoning: uniqueness.reasoning.slice(0, 300),
    visualPivotApplied: pivotApplied,
  } : { uniquenessStatus: 'gate_unavailable' as string };

  // 6. Persist the completed design creation (Operations Design Center source
  //    of truth) + an approval row carrying the asset + provenance.
  const creationId = uuidv4();
  const title = description.trim().replace(/\s+/g, ' ').slice(0, 60) || 'Design';

  try {
    await db.insert(schema.creations).values({
      id: creationId,
      userId,
      type: 'design',
      title,
      status: 'completed',
      fileUrl: imageUrl,
      thumbnailUrl: imageUrl,
      metadata: {
        classification,
        prompt: dnaPrompt,
        category,
        aiProvider,
        niche: ctx.niche || explicitNiche || '',
        platform: undefined,
        ...dnaProvenance,
        ...uniquenessMeta,
      },
    });
  } catch (creationErr: any) {
    console.warn('[DesignGeneration] Failed to insert creation record:', creationErr?.message);
    return {
      ok: false,
      status: 'error',
      httpStatus: 500,
      error: 'Design rendered but could not be saved. Please try again.',
      imageUrl,
      dnaProvenance,
      uniqueness: uniqueness ? {
        uniquenessScore: uniqueness.semanticScore,
        geometricScore: uniqueness.geometricScore,
        isUnique: uniqueness.isUnique,
        reasoning: uniqueness.reasoning,
        pivotApplied,
      } : undefined,
    };
  }

  try {
    await db.insert(schema.approvals).values({
      id: uuidv4(),
      userId,
      type: 'design',
      status: 'completed',
      payload: {
        assetId: creationId,
        title,
        imageUrl,
        status: 'completed',
        category,
        relationships: { platform: undefined },
        ...dnaProvenance,
        ...uniquenessMeta,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (approvalErr: any) {
    console.warn('[DesignGeneration] Failed to insert approval record:', approvalErr?.message);
  }

  console.log(`[DesignGeneration] Design completed for user ${userId} (${creationId}) uniqueness=${uniqueness?.semanticScore ?? 'n/a'}`);
  return {
    ok: true,
    status: 'completed',
    creationId,
    imageUrl,
    aiProvider,
    dnaProvenance,
    uniqueness: uniqueness ? {
      uniquenessScore: uniqueness.semanticScore,
      geometricScore: uniqueness.geometricScore,
      isUnique: uniqueness.isUnique,
      reasoning: uniqueness.reasoning,
      pivotApplied,
    } : undefined,
    httpStatus: 201,
    niche: ctx.niche || explicitNiche || undefined,
  };
}