import { db, schema } from '../db/index.js';
const { integrations } = schema;
import { eq, and } from 'drizzle-orm';
import { encrypt, decrypt } from '../utils/security.js';
import { v4 as uuidv4 } from 'uuid';

export class IntegrationService {
  async saveIntegration(userId: string, platform: string, credentials: any, platformAccountId?: string, platformAccountHandle?: string) {
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
          platformAccountId: platformAccountId || existing[0].platformAccountId,
          platformAccountHandle: platformAccountHandle || existing[0].platformAccountHandle,
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, existing[0].id));
      return existing[0].id;
    } else {
      const id = uuidv4();
      await db.insert(integrations).values({
        id,
        userId,
        platform,
        platformAccountId,
        platformAccountHandle,
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
