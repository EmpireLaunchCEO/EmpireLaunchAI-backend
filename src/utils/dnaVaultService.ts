import { db, schema } from '../db/index.js';
const { dnaStrands } = schema;
import { eq, and, desc, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

/**
 * DNA Strand shape — the atomic unit of design intelligence.
 * Each strand encodes the "genetic signature" of a design element
 * extracted from platforms like Canva, Kittl, CapCut, Instagram, etc.
 */
export interface DnaStrand {
  id?: string;
  category: 'avatar' | 'animal' | 'flower' | 'layout' | 'typography' | 'palette' | 'niche_pattern' | 'background';
  subCategory?: string;
  embedding?: number[];      // 1536-dimensional semantic vector
  manifest: Record<string, any>;  // The "Logic Manifest" — reconstruction parameters
  performanceScore: number;      // 0-100, weighted by viral/sales success
  sourcePlatform?: string;       // 'kittl', 'canva', 'instagram', 'etsy'
  externalId?: string;           // Original platform asset ID
  metadata?: Record<string, any>; // Tags, brand traits, extraction context. MUST contain isSynthesized flag.
  createdAt?: Date;

  /**
   * Whether this strand is an AI-Synthesized original (not a copy of source content).
   * TRUE for all strands created by the DNA Hunt pipeline.
   * FALSE only for direct imports that should not be displayed as originals.
   */
  isSynthesized?: boolean;

  /**
   * Whether this strand is visible globally to all users.
   */
  isGlobal?: boolean;

  /**
   * Text-to-image prompt that the frontend can use to generate an ORIGINAL visual
   * preview. This prompt describes a unique design based on the DNA parameters,
   * NOT a replica of any source platform content.
   */
  synthesisPrompt?: string;
}

/**
 * Vector Similarity Result
 */
export interface SimilarityResult {
  strand: DnaStrand;
  distance: number;
}

/**
 * DNA Vault Service
 * 
 * Manages the Universal DNA Vault — a high-dimensional vector storage
 * for 500k+ Style DNA strands. Uses a "Vector+Metadata" approach with
 * zero-cost storage (no raw images, just manifests + embeddings).
 * 
 * Storage budget for 500k strands:
 *   - Embedding (1536 f32): ~6.1 KB per strand
 *   - Manifest JSON: ~1.5 KB per strand (GZip compressed ~0.75 KB)
 *   - Total: ~7.6 KB per strand → ~3.8 GB raw → ~5 GB with indexes
 *   - Turso free tier: 9 GB → comfortably within budget
 */
export class DnaVaultService {
  
  /**
   * Store a new DNA strand in the vault.
   * The manifest contains the "Logic Manifest" — reconstruction parameters
   * that allow the Generative Synthesis Engine to recreate the design.
   */
  async storeStrand(strand: DnaStrand): Promise<string> {
    const id = strand.id || uuidv4();
    
    // Duplication Check: skip if externalId already exists from the same platform
    if (strand.externalId && strand.sourcePlatform) {
      const existing = await db.select()
        .from(dnaStrands)
        .where(and(
          eq(dnaStrands.externalId, strand.externalId),
          eq(dnaStrands.sourcePlatform, strand.sourcePlatform)
        ))
        .limit(1);
      
      if (existing.length > 0) {
        console.log(`[DnaVault] Skipping duplicate strand: ${strand.externalId} on ${strand.sourcePlatform}`);
        return existing[0].id;
      }
    }

    await db.insert(dnaStrands).values({
      id,
      category: strand.category,
      subCategory: strand.subCategory || null,
      embedding: strand.embedding ? JSON.stringify(strand.embedding) : null,
      manifest: JSON.stringify(strand.manifest),
      performanceScore: strand.performanceScore,
      sourcePlatform: strand.sourcePlatform || null,
      externalId: strand.externalId || null,
      isGlobal: !!strand.isGlobal,
      metadata: strand.metadata ? JSON.stringify(strand.metadata) : null,
      createdAt: new Date(),
    });

    console.log(`[DnaVault] Stored strand ${id} (${strand.category}/${strand.subCategory || 'generic'})`);
    return id;
  }

  /**
   * Bulk store strands — used when harvesting from platforms.
   */
  async bulkStore(strands: DnaStrand[]): Promise<number> {
    let count = 0;
    const vaultPath = '/home/team/shared/DNA_VAULT';
    
    // Ensure vault directory exists
    const fs = await import('fs');
    if (!fs.existsSync(vaultPath)) {
      fs.mkdirSync(vaultPath, { recursive: true });
    }

    for (const strand of strands) {
      try {
        await this.storeStrand(strand);
      } catch (dbError: any) {
        console.warn(`[DnaVault] DB store failed for ${strand.id}, falling back to file: ${dbError.message}`);
        
        // JSON Fallback
        const filePath = `${vaultPath}/${strand.category}_${strand.id || uuidv4()}.json`;
        fs.writeFileSync(filePath, JSON.stringify(strand, null, 2));
      }
      count++;
    }
    console.log(`[DnaVault] Bulk processed ${count} strands (DB + Fallback)`);
    return count;
  }

  /**
   * Retrieve a strand by ID.
   */
  async getStrand(id: string): Promise<DnaStrand | null> {
    const [row] = await db.select().from(dnaStrands).where(eq(dnaStrands.id, id)).limit(1);
    if (!row) return null;
    return this.rowToStrand(row);
  }

  /**
   * Find similar strands by category using cosine similarity
   * over the JSON-stored embedding vectors.
   * 
   * NOTE: For true 500k-scale vector search, switch to:
   *   - Turso Vector (libsql + vector extension)
   *   - pgvector (PostgreSQL)
   *   - Dedicated vector DB (Chroma, Qdrant, Pinecone)
   * 
   * This implementation uses in-memory cosine similarity for the
   * prototype scale (< 10k strands). At 500k+, we recommend adopting
   * a proper vector index.
   */
  async findSimilar(
    embedding: number[],
    category?: string,
    limit: number = 10
  ): Promise<SimilarityResult[]> {
    let query = db.select().from(dnaStrands);
    
    if (category) {
      query = query.where(eq(dnaStrands.category, category));
    }

    const rows = await query;
    const results: SimilarityResult[] = [];

    for (const row of rows) {
      if (!row.embedding) continue;
      
      const rowEmbedding = JSON.parse(row.embedding as string);
      if (!Array.isArray(rowEmbedding)) continue;

      const distance = this.cosineSimilarity(embedding, rowEmbedding);
      results.push({
        strand: this.rowToStrand(row),
        distance,
      });
    }

    // Sort by similarity (highest first)
    results.sort((a, b) => b.distance - a.distance);
    return results.slice(0, limit);
  }

  /**
   * Search strands by category and performance score for the
   * Generative Synthesis Engine to find the best building blocks.
   */
  async findTopPerformers(
    category: string,
    minScore: number = 70,
    limit: number = 20
  ): Promise<DnaStrand[]> {
    const rows = await db.select()
      .from(dnaStrands)
      .where(and(
        eq(dnaStrands.category, category),
        sql`${dnaStrands.performanceScore} >= ${minScore}`
      ))
      .orderBy(desc(dnaStrands.performanceScore))
      .limit(limit);

    return (rows as any[]).map((r: any) => this.rowToStrand(r));
  }

  /**
   * Search by source platform (e.g., all Kittl premium fonts).
   */
  async findBySource(
    platform: string,
    category?: string,
    limit: number = 50
  ): Promise<DnaStrand[]> {
    let query = db.select()
      .from(dnaStrands)
      .where(eq(dnaStrands.sourcePlatform, platform));

    if (category) {
      query = query.where(eq(dnaStrands.category, category));
    }

    const rows = await query.orderBy(desc(dnaStrands.performanceScore)).limit(limit);
    return (rows as any[]).map((r: any) => this.rowToStrand(r));
  }

  /**
   * Count strands by category — used for storage budget tracking.
   */
  async countByCategory(): Promise<Record<string, number>> {
    const rows = await db.select().from(dnaStrands);
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.category] = (counts[row.category] || 0) + 1;
    }
    return counts;
  }

  /**
   * Get total strand count and estimated storage.
   */
  async getVaultStats() {
    const rows = await db.select().from(dnaStrands);
    const total = rows.length;
    const counts = await this.countByCategory();
    
    // Storage estimation
    const avgEmbeddingSize = 6.1 * 1024; // ~6.1 KB
    const avgManifestSize = 1.5 * 1024;  // ~1.5 KB
    const estimatedRawBytes = total * (avgEmbeddingSize + avgManifestSize);
    const estimatedIndexOverhead = estimatedRawBytes * 0.25; // ~25% index overhead

    return {
      totalStrands: total,
      byCategory: counts,
      estimatedStorageBytes: estimatedRawBytes + estimatedIndexOverhead,
      estimatedStorageMB: Math.round((estimatedRawBytes + estimatedIndexOverhead) / (1024 * 1024)),
      estimatedStorageGB: ((estimatedRawBytes + estimatedIndexOverhead) / (1024 * 1024 * 1024)).toFixed(3),
      avgStrandSizeBytes: total > 0 ? Math.round((avgEmbeddingSize + avgManifestSize)) : 0,
      tursoFreeTierGB: 9,
      withinFreeTier: (estimatedRawBytes + estimatedIndexOverhead) < (9 * 1024 * 1024 * 1024),
    };
  }

  /**
   * Search strands by niche/tags in metadata or category.
   */
  async searchStrands(query: string, limit: number = 10): Promise<DnaStrand[]> {
    // Basic implementation searching metadata tags or category
    const rows = await db.select().from(dnaStrands);
    
    const results = rows.filter((row: any) => {
      const metadata = row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {};
      const tags = metadata.tags || [];
      const searchableText = `${row.category} ${row.subCategory} ${tags.join(' ')}`.toLowerCase();
      return searchableText.includes(query.toLowerCase());
    });

    return results.slice(0, limit).map((row: any) => this.rowToStrand(row));
  }

  /**
   * Update a strand's performance score (from sales/viral data).
   */
  async updatePerformanceScore(id: string, score: number) {
    await db.update(dnaStrands)
      .set({ performanceScore: score })
      .where(eq(dnaStrands.id, id));
  }

  /**
   * Delete a strand by ID.
   */
  async deleteStrand(id: string) {
    await db.delete(dnaStrands).where(eq(dnaStrands.id, id));
  }

  /**
   * Find global DNA strands.
   */
  async findGlobalStrands(limit: number = 50): Promise<DnaStrand[]> {
    const rows = await db.select()
      .from(dnaStrands)
      .where(eq(dnaStrands.isGlobal, true))
      .orderBy(desc(dnaStrands.createdAt))
      .limit(limit);

    return (rows as any[]).map((r: any) => this.rowToStrand(r));
  }

  /**
   * Seed the vault with initial premium DNA from known high-performing
   * design archetypes. Used during initial vault population.
   */
  async seedPremiumArchetypes() {
    const archetypes = this.getArchetypeStrands();
    const count = await this.bulkStore(archetypes);
    console.log(`[DnaVault] Seeded ${count} premium archetype strands`);
    return count;
  }

  // ─── Private Helpers ──────────────────────────────────────

  private rowToStrand(row: any): DnaStrand {
    return {
      id: row.id,
      category: row.category,
      subCategory: row.subCategory || undefined,
      embedding: row.embedding ? (typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding) : undefined,
      manifest: typeof row.manifest === 'string' ? JSON.parse(row.manifest) : row.manifest,
      performanceScore: row.performanceScore,
      sourcePlatform: row.sourcePlatform || undefined,
      externalId: row.externalId || undefined,
      metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined,
      isSynthesized: row.isSynthesized !== undefined ? !!row.isSynthesized : true,
      isGlobal: !!row.isGlobal,
      synthesisPrompt: row.synthesisPrompt || undefined,
      createdAt: row.createdAt ? (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)) : undefined,
    };
  }

  /**
   * Cosine similarity between two vectors.
   * Values range from -1 (opposite) to 1 (identical).
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dotProduct / denom;
  }

  /**
   * Returns a set of premium design archetype strands to seed the vault.
   * These are extracted from known high-converting design patterns
   * across multiple categories.
   */
  private getArchetypeStrands(): DnaStrand[] {
    return [
      {
        category: 'layout',
        subCategory: 'vintage',
        manifest: {
          compositionalRatio: 'golden_ratio',
          negativeSpaceRatio: 0.35,
          typographySignature: { headline: 'serif_bold', body: 'sans_light', ratio: 2.5 },
          layerDepth: { foreground: 3, midground: 2, background: 1 },
          saliencyMap: { focusX: 0.618, focusY: 0.382 },
          colorPalette: ['#8B4513', '#D2B48C', '#F5F5DC', '#2F4F4F'],
        },
        performanceScore: 92,
        sourcePlatform: 'kittl',
        metadata: { tags: ['vintage', 'warm', 'earthy', 'premium'], brandTrait: 'heritage' },
      },
      {
        category: 'layout',
        subCategory: 'modern_minimal',
        manifest: {
          compositionalRatio: 'rule_of_thirds',
          negativeSpaceRatio: 0.55,
          typographySignature: { headline: 'sans_bold', body: 'sans_light', ratio: 3.0 },
          layerDepth: { foreground: 2, midground: 1, background: 1 },
          saliencyMap: { focusX: 0.5, focusY: 0.4 },
          colorPalette: ['#FFFFFF', '#000000', '#F0F0F0', '#333333'],
        },
        performanceScore: 88,
        sourcePlatform: 'canva',
        metadata: { tags: ['minimal', 'clean', 'modern', 'professional'], brandTrait: 'contemporary' },
      },
      {
        category: 'typography',
        subCategory: 'premium_serif',
        manifest: {
          fontFamily: 'Playfair Display',
          fontWeight: 700,
          letterSpacing: 0.02,
          lineHeight: 1.2,
          alignment: 'center',
          animation: 'fade_in',
          pairWith: 'Montserrat Light',
        },
        performanceScore: 90,
        sourcePlatform: 'kittl',
        metadata: { tags: ['elegant', 'luxury', 'editorial'], brandTrait: 'premium' },
      },
      {
        category: 'palette',
        subCategory: 'pastel_duo',
        manifest: {
          primary: '#FFB6C1',
          secondary: '#B0E0E6',
          accent: '#FF69B4',
          background: '#FFFFFF',
          text: '#333333',
          mood: 'soft_playful',
          contrast: 4.5,
        },
        performanceScore: 85,
        sourcePlatform: 'canva',
        metadata: { tags: ['pastel', 'soft', 'feminine', 'gentle'], brandTrait: 'approachable' },
      },
      {
        category: 'niche_pattern',
        subCategory: 'high_conversion_cta',
        manifest: {
          ctaStyle: 'urgency_button',
          buttonShape: 'rounded_rectangle',
          buttonColor: '#FF4500',
          textOnButton: '#FFFFFF',
          shadowDepth: 4,
          animation: 'pulse',
          placement: 'bottom_right',
          actionVerb: 'Shop Now',
        },
        performanceScore: 95,
        sourcePlatform: 'instagram',
        metadata: { tags: ['cta', 'conversion', 'urgency', 'sales'], brandTrait: 'action_oriented' },
      },
      {
        category: 'layout',
        subCategory: 'social_carousel',
        manifest: {
          slideCount: 5,
          pacing: 'storytelling',
          firstSlideHook: 'problem_agitation',
          lastSlideCta: 'link_in_bio',
          textPosition: 'bottom_overlay',
          gradient: 'dark_top_fade',
        },
        performanceScore: 87,
        sourcePlatform: 'instagram',
        metadata: { tags: ['carousel', 'instagram', 'educational', 'engagement'], brandTrait: 'educator' },
      },
      {
        category: 'avatar',
        subCategory: 'minimalist_business',
        manifest: {
          facialLandmarks: '68_point',
          lightingDna: { type: 'three_point', intensity: 0.8, direction: 'front_left' },
          shaderDna: { subsurface: 0.3, roughness: 0.2, poreDensity: 0.5 },
          backgroundColor: '#F5F5F5',
          framing: 'head_and_shoulders',
        },
        performanceScore: 82,
        sourcePlatform: 'canva',
        metadata: { tags: ['professional', 'business', 'headshot', 'clean'], brandTrait: 'credible' },
      },
      // ─── AVATAR: Casual Lifestyle ──────────────────────────────
      {
        category: 'avatar',
        subCategory: 'casual_lifestyle',
        manifest: {
          facialLandmarks: '68_point',
          lightingDna: { type: 'natural_window', intensity: 0.6, direction: 'side' },
          shaderDna: { subsurface: 0.4, roughness: 0.3, poreDensity: 0.4 },
          backgroundColor: '#E8F4F8',
          framing: 'environmental',
          expression: 'warm_smile',
        },
        performanceScore: 78,
        sourcePlatform: 'instagram',
        metadata: { tags: ['casual', 'lifestyle', 'approachable', 'warm'], brandTrait: 'friendly' },
      },
      // ─── ANIMAL: Pet Portrait ──────────────────────────────────
      {
        category: 'animal',
        subCategory: 'pet_portrait',
        manifest: {
          gaitCurves: { walk: 'standard_canine', trot: 'playful' },
          patternDna: { furType: 'short_hair', primaryColor: '#D4A574', secondaryColor: '#FFFFFF' },
          proportions: { bodyToHead: 1.8, legRatio: 0.6 },
          backgroundColor: '#F0EDE5',
          framing: 'close_up',
        },
        performanceScore: 86,
        sourcePlatform: 'etsy',
        metadata: { tags: ['pet', 'animal', 'portrait', 'cute'], brandTrait: 'heartwarming' },
      },
      // ─── ANIMAL: Wildlife Illustration ─────────────────────────
      {
        category: 'animal',
        subCategory: 'wildlife_illustration',
        manifest: {
          gaitCurves: { walk: 'forest_floor', run: 'sprint' },
          patternDna: { furType: 'patterned', primaryColor: '#8B6914', secondaryColor: '#3E2723' },
          proportions: { bodyToHead: 2.2, antlerRatio: 0.5 },
          colorPalette: ['#8B6914', '#3E2723', '#A1887F', '#F5F5DC'],
          atmosphere: 'forest_depth',
        },
        performanceScore: 84,
        sourcePlatform: 'kittl',
        metadata: { tags: ['wildlife', 'nature', 'illustration', 'forest'], brandTrait: 'naturalist' },
      },
      // ─── BACKGROUND: Studio Gradient ───────────────────────────
      {
        category: 'background',
        subCategory: 'studio_gradient',
        manifest: {
          gradientType: 'radial',
          primaryColor: '#667eea',
          secondaryColor: '#764ba2',
          texture: 'smooth',
          lighting: 'soft_diffuse',
          depthEffect: 'subtle_shadow',
          aspectRatio: '16:9',
        },
        performanceScore: 91,
        sourcePlatform: 'canva',
        metadata: { tags: ['gradient', 'studio', 'modern', 'clean'], brandTrait: 'polished' },
      },
      // ─── BACKGROUND: Organic Texture ───────────────────────────
      {
        category: 'background',
        subCategory: 'organic_texture',
        manifest: {
          gradientType: 'linear',
          primaryColor: '#E8D5B7',
          secondaryColor: '#D4B896',
          texture: 'paper_grain',
          lighting: 'warm_ambient',
          depthEffect: 'vignette',
          aspectRatio: '4:3',
          noiseSeed: 0.42,
        },
        performanceScore: 79,
        sourcePlatform: 'kittl',
        metadata: { tags: ['organic', 'texture', 'warm', 'natural', 'paper'], brandTrait: 'earthy' },
      },
    ];
  }
}

export const dnaVaultService = new DnaVaultService();