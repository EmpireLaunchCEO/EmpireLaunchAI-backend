import { db } from '../db/index.js';
import { integrations } from '../db/sqlite-schema.js';
import { eq, and } from 'drizzle-orm';
import { encrypt, decrypt } from '../utils/security.js';
import { randomUUID } from 'crypto';

export class IntegrationService {
  async saveIntegration(userId: string, platform: string, credentials: any) {
    const encryptedCredentials = encrypt(JSON.stringify(credentials));
    
    const existing = await db.select()
      .from(integrations)
      .where(and(
        eq(integrations.userId, userId),
        eq(integrations.platform, platform)
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(integrations)
        .set({
          credentials: encryptedCredentials,
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, existing[0].id));
      return existing[0].id;
    } else {
      const id = randomUUID();
      await db.insert(integrations).values({
        id,
        userId,
        platform,
        credentials: encryptedCredentials,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return id;
    }
  }

  async getCredentials(userId: string, platform: string) {
    const results = await db.select()
      .from(integrations)
      .where(and(
        eq(integrations.userId, userId),
        eq(integrations.platform, platform),
        eq(integrations.isActive, true)
      ))
      .limit(1);

    if (results.length === 0) return null;

    const decrypted = decrypt(results[0].credentials);
    return JSON.parse(decrypted);
  }
}

export const integrationService = new IntegrationService();
