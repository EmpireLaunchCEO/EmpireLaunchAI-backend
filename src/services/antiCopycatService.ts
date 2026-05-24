import sharp from 'sharp';
// @ts-ignore
import blockhash from 'blockhash';
import { db, schema } from '../db/index.js';
const { designHashes } = schema;
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export class AntiCopycatService {
  /**
   * Validates that a generated design is unique compared to competitors in the niche.
   */
  async validateUniqueness(imageBuffer: Buffer, platform: string, externalId?: string) {
    const hash = await this.generatePHash(imageBuffer);
    
    // Check against DB
    const existingHashes = await db.select().from(designHashes).where(eq(designHashes.platform, platform));

    for (const entry of existingHashes) {
      const distance = this.hammingDistance(hash, entry.hash);
      
      if (distance < 8) {
        throw new Error(`Critical Similarity Detected (Distance: ${distance}). Geometric similarity too high.`);
      }
      
      if (distance < 15) {
        console.warn(`Warning: High similarity detected (Distance: ${distance}). Visual pivot recommended.`);
      }
    }

    // Save the new hash to avoid future duplicates
    await db.insert(designHashes).values({
      id: uuidv4(),
      platform,
      externalId,
      hash,
      createdAt: new Date()
    });

    return true;
  }

  /**
   * Generates a perceptual hash using blockhash.
   */
  async generatePHash(imageBuffer: Buffer): Promise<string> {
    const { data, info } = await sharp(imageBuffer)
      .resize(8, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // @ts-ignore
    const hash = blockhash.blockhashData({
      data: new Uint8ClampedArray(data),
      width: info.width,
      height: info.height
    }, 8, 2);

    return hash;
  }

  /**
   * Calculates Hamming distance between two hex hashes.
   */
  private hammingDistance(h1: string, h2: string): number {
    let distance = 0;
    for (let i = 0; i < h1.length; i++) {
      const b1 = parseInt(h1[i], 16).toString(2).padStart(4, '0');
      const b2 = parseInt(h2[i], 16).toString(2).padStart(4, '0');
      for (let j = 0; j < 4; j++) {
        if (b1[j] !== b2[j]) distance++;
      }
    }
    return distance;
  }

  /**
   * Mocks semantic similarity check (CLIP).
   */
  private async checkSemanticSimilarity(imageBuffer: Buffer, niche: string): Promise<number> {
    // In production, this would call a CLIP model endpoint
    return Math.random() * 0.5; // Returning low similarity for mock
  }

  /**
   * Fetches known competitor hashes for a niche.
   */
  private async getCompetitorHashes(niche: string) {
    // In production, this would query a database of top competitors
    // For now, returning mock hashes
    return [
      { id: 'comp_1', hash: 'f0f0f0f0f0f0f0f0' },
      { id: 'comp_2', hash: '0f0f0f0f0f0f0f0f' }
    ];
  }
}

export const antiCopycatService = new AntiCopycatService();
