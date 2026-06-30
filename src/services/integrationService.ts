import { db, schema } from '../db/index.js';
const { integrations } = schema;
import { eq, and } from 'drizzle-orm';
import { encrypt, decrypt } from '../utils/security.js';
import { v4 as uuidv4 } from 'uuid';

export class IntegrationService {
  async saveIntegration(userId: string, platform: string, credentials: any, platformAccountId?: string, platformAccountHandle?: string, goalId?: string) {
    const encryptedCredentials = encrypt(JSON.stringify(credentials));
    
    const existing = await db.select()
      .from(integrations)
      .where(and(
        eq(integrations.userId, userId),
        eq(integrations.platform, platform),
        goalId ? eq(integrations.goalId, goalId) : eq(integrations.userId, userId) // Scope to goal if provided
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(integrations)
        .set({
          credentials: encryptedCredentials,
          platformAccountId: platformAccountId || existing[0].platformAccountId,
          platformAccountHandle: platformAccountHandle || existing[0].platformAccountHandle,
          goalId: goalId || existing[0].goalId,
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, existing[0].id));
      
      await this.updateStatusInSettings(userId, platform);
      return existing[0].id;
    } else {
      const id = uuidv4();
      await db.insert(integrations).values({
        id,
        userId,
        goalId,
        platform,
        platformAccountId,
        platformAccountHandle,
        credentials: encryptedCredentials,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await this.updateStatusInSettings(userId, platform);
      return id;
    }
  }

  /**
   * Updates user settings to reflect a connected platform (Green Check UI)
   */
  async updateStatusInSettings(userId: string, platform: string) {
    try {
      const [settings] = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).limit(1);
      if (settings) {
        const connected = settings.connectedPlatforms as string[] || [];
        if (!connected.includes(platform)) {
          connected.push(platform);
          await db.update(schema.userSettings)
            .set({ 
              connectedPlatforms: connected,
              linkingComplete: true,
              updatedAt: new Date() 
            })
            .where(eq(schema.userSettings.userId, userId));
        }
      }
    } catch (err) {
      console.warn(`[IntegrationService] Failed to update user settings for \${platform}:`, err);
    }
  }

  async getCredentials(userId: string, platform: string, goalId?: string) {
    const results = await db.select()
      .from(integrations)
      .where(and(
        eq(integrations.userId, userId),
        eq(integrations.platform, platform),
        eq(integrations.isActive, true),
        goalId ? eq(integrations.goalId, goalId) : eq(integrations.userId, userId)
      ))
      .limit(1);

    if (results.length === 0) return null;

    const decrypted = decrypt(results[0].credentials);
    return JSON.parse(decrypted);
  }
}

export const integrationService = new IntegrationService();
