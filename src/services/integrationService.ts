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

    let integrationId: string;

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
      integrationId = existing[0].id;
    } else {
      integrationId = uuidv4();
      await db.insert(integrations).values({
        id: integrationId,
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
    }

    // Auto-trigger DNA harvest when a platform is newly linked
    // Uses dynamic import to avoid circular dependency
    this.triggerDnaHarvestIfIdle(userId, platform).catch(err =>
      console.error('[IntegrationService] DNA harvest trigger error:', err)
    );

    return integrationId;
  }

  /**
   * Auto-trigger the Mass DNA Harvester after a new platform link, if it isn't already running.
   */
  private async triggerDnaHarvestIfIdle(userId: string, platform: string): Promise<void> {
    try {
      const { massDnaHarvester } = await import('./massDnaHarvestWorker.js');
      const stats = massDnaHarvester.getStats();
      if (!stats.isRunning) {
        console.log(`[IntegrationService] Auto-triggering DNA harvest for linked platform: ${platform}`);
        massDnaHarvester.start().then(() => {
          console.log(`[IntegrationService] DNA harvest completed after linking ${platform}`);
        });
      } else {
        console.log(`[IntegrationService] DNA harvest already running, skipping auto-trigger for ${platform}`);
      }
    } catch (err) {
      console.warn('[IntegrationService] Could not trigger DNA harvest:', err);
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

  async removeIntegration(userId: string, platform: string) {
    // Delete the integration record
    await db.delete(integrations)
      .where(and(
        eq(integrations.userId, userId),
        eq(integrations.platform, platform)
      ));

    // Remove platform from user settings
    try {
      const [settings] = await db.select().from(schema.userSettings).where(eq(schema.userSettings.userId, userId)).limit(1);
      if (settings) {
        const connected = (settings.connectedPlatforms as string[] || []).filter(p => p !== platform);
        await db.update(schema.userSettings)
          .set({ 
            connectedPlatforms: connected,
            updatedAt: new Date() 
          })
          .where(eq(schema.userSettings.userId, userId));
      }
    } catch (err) {
      console.warn(`[IntegrationService] Failed to update user settings after disconnecting ${platform}:`, err);
    }

    // Clear saved Playwright session from vault to prevent stale sessions
    try {
      const { vaultService } = await import('./vaultService.js');
      await vaultService.deleteSecret(userId, platform, 'NEURAL_SESSION').catch(() => {});
      await vaultService.deleteSecret(userId, platform, 'SESSION_TOKEN').catch(() => {});
      console.log(`[IntegrationService] Cleared vault sessions for ${platform}`);
    } catch (err) {
      console.warn(`[IntegrationService] Failed to clear vault sessions for ${platform}:`, err);
    }
  }
}

export const integrationService = new IntegrationService();
