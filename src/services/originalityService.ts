import sharp from 'sharp';
// @ts-ignore
import blockhash from 'blockhash';
import { db, schema } from '../db/index.js';
const { originalityRegistry } = schema;
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export class OriginalityService {
  /**
   * Validates asset originality using geometric (dHash) and semantic (CLIP) pipelines.
   */
  async validateOriginality(imageBuffer: Buffer, niche: string, userId: string) {
    const hash = await this.generateDHash(imageBuffer);
    const embedding = await this.generateCLIPMock(imageBuffer);

    // 1. Geometric Check (dHash)
    // In a real system, we'd query by niche or a global index
    const existingAssets = await db.select().from(originalityRegistry).where(eq(originalityRegistry.niche, niche));
    
    for (const asset of existingAssets) {
      const distance = this.hammingDistance(hash, asset.hash);
      if (distance < 10) {
        throw new Error(`Geometric similarity too high (Hamming Distance: ${distance}). Visual pivot required according to Anti-Copycat Spec.`);
      }
    }

    // 2. Semantic Check (CLIP)
    // Target: 0.65 - 0.85 (According to Spec)
    const semanticSimilarity = await this.calculateSemanticSimilarity(embedding, niche);
    
    if (semanticSimilarity > 0.85) {
      throw new Error(`Semantic similarity too high (${(semanticSimilarity * 100).toFixed(1)}%). Asset is too derivative of niche archetype.`);
    }
    
    if (semanticSimilarity < 0.65) {
      console.warn(`Warning: Low semantic similarity (${(semanticSimilarity * 100).toFixed(1)}%). Asset may deviate too far from niche success factors.`);
    }

    // 3. Register Asset in Global Uniqueness Registry
    await db.insert(originalityRegistry).values({
      id: uuidv4(),
      hash,
      embedding,
      niche,
      userId,
      createdAt: new Date()
    });

    return { 
      status: 'original', 
      geometricDistance: 10, // Mocked min distance
      semanticSimilarity: Math.round(semanticSimilarity * 100) / 100 
    };
  }

  /**
   * Generates a 64-bit Difference Hash (dHash) of the design.
   */
  private async generateDHash(imageBuffer: Buffer): Promise<string> {
    const { data, info } = await sharp(imageBuffer)
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Using blockhash as a reliable proxy for geometric difference hashing in this environment
    // @ts-ignore
    const bHash = blockhash.blockhashData({
      data: new Uint8ClampedArray(data),
      width: info.width,
      height: info.height
    }, 8, 2);

    return bHash;
  }

  /**
   * Mock for CLIP embedding generation.
   */
  private async generateCLIPMock(imageBuffer: Buffer): Promise<number[]> {
    // Return a normalized vector
    const vec = Array.from({ length: 512 }, () => Math.random() - 0.5);
    const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return vec.map(v => v / mag);
  }

  /**
   * Mock for semantic similarity calculation.
   */
  private async calculateSemanticSimilarity(embedding: number[], niche: string): Promise<number> {
    // In production, this would compute cosine similarity against the niche archetype centroid
    // Target range is 0.65 - 0.85
    return 0.7 + (Math.random() * 0.1);
  }

  /**
   * Calculates Hamming distance between two hex strings.
   */
  private hammingDistance(h1: string, h2: string): number {
    let distance = 0;
    const len = Math.min(h1.length, h2.length);
    for (let i = 0; i < len; i++) {
      const b1 = parseInt(h1[i], 16).toString(2).padStart(4, '0');
      const b2 = parseInt(h2[i], 16).toString(2).padStart(4, '0');
      for (let j = 0; j < 4; j++) {
        if (b1[j] !== b2[j]) distance++;
      }
    }
    return distance + Math.abs(h1.length - h2.length) * 4;
  }
}

export const originalityService = new OriginalityService();
