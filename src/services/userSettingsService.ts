import { v4 as uuidv4 } from 'uuid';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';

/**
 * Full mapping of the frontend EmpireContext localStorage state.
 * Used to persist and hydrate user settings across sessions.
 */
export interface UserSettingsDTO {
  // Business Info
  businessAngle?: string;
  businessNiche?: string;

  // Onboarding state
  isOnboarded?: boolean;
  isLinkingComplete?: boolean;
  isPaid?: boolean;
  onboardingComplete?: boolean;
  linkingComplete?: boolean;
  notificationModalDismissed?: boolean;

  // Platform permissions: { etsy: 'co-pilot'|'empire', ... }
  platformPermissions?: Record<string, string>;

  // Connected platforms
  connectedPlatforms?: string[];

  // Theme / UI preferences
  theme?: string;
  language?: string;
  currency?: string;

  // AI Mode
  aiMode?: 'co-pilot' | 'empire';

  // Automation
  autoSendRetention?: boolean;

  // Notification preferences
  notificationSettings?: {
    sales?: boolean;
    approvals?: boolean;
    [key: string]: boolean | undefined;
  };

  // Empire notes (freeform text array)
  empireNotes?: string[];
}

export class UserSettingsService {
  /**
   * Fetch user settings by userId. Returns defaults if none exist.
   */
  async getSettings(userId: string): Promise<UserSettingsDTO> {
    const [settings] = await db.select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId))
      .limit(1);

    if (!settings) {
      return this.getDefaults();
    }

    return this.mapRowToDTO(settings);
  }

  /**
   * Upsert (create or update) user settings.
   */
  async saveSettings(userId: string, dto: Partial<UserSettingsDTO>): Promise<UserSettingsDTO> {
    const existing = await db.select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId))
      .limit(1);

    const now = new Date();

    if (existing.length === 0) {
      // Create
      const row: any = {
        id: uuidv4(),
        userId,
        businessAngle: dto.businessAngle ?? null,
        businessNiche: dto.businessNiche ?? null,
        platformPermissions: dto.platformPermissions ?? null,
        connectedPlatforms: dto.connectedPlatforms ?? null,
        theme: dto.theme ?? 'light',
        language: dto.language ?? 'en',
        currency: dto.currency ?? 'USD',
        aiMode: dto.aiMode ?? 'co-pilot',
        autoSendRetention: dto.autoSendRetention ?? false,
        notificationSettings: dto.notificationSettings ?? { sales: true, approvals: true },
        onboardingComplete: dto.onboardingComplete ?? false,
        linkingComplete: dto.linkingComplete ?? false,
        notificationModalDismissed: dto.notificationModalDismissed ?? false,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(schema.userSettings).values(row);
      return this.mapRowToDTO(row);
    }

    // Update
    const updateData: any = { updatedAt: now };
    if (dto.businessAngle !== undefined) updateData.businessAngle = dto.businessAngle;
    if (dto.businessNiche !== undefined) updateData.businessNiche = dto.businessNiche;
    if (dto.platformPermissions !== undefined) updateData.platformPermissions = dto.platformPermissions;
    if (dto.connectedPlatforms !== undefined) updateData.connectedPlatforms = dto.connectedPlatforms;
    if (dto.theme !== undefined) updateData.theme = dto.theme;
    if (dto.language !== undefined) updateData.language = dto.language;
    if (dto.currency !== undefined) updateData.currency = dto.currency;
    if (dto.aiMode !== undefined) updateData.aiMode = dto.aiMode;
    if (dto.autoSendRetention !== undefined) updateData.autoSendRetention = dto.autoSendRetention;
    if (dto.notificationSettings !== undefined) updateData.notificationSettings = dto.notificationSettings;
    if (dto.onboardingComplete !== undefined) updateData.onboardingComplete = dto.onboardingComplete;
    if (dto.linkingComplete !== undefined) updateData.linkingComplete = dto.linkingComplete;
    if (dto.notificationModalDismissed !== undefined) {
      updateData.notificationModalDismissed = dto.notificationModalDismissed;
    }

    await db.update(schema.userSettings)
      .set(updateData)
      .where(eq(schema.userSettings.userId, userId));

    // Return merged result
    return this.getSettings(userId);
  }

  /**
   * Helper: sync a single field by key path.
   * Used for incremental localStorage sync (e.g., when user toggles a single setting).
   */
  async updateField(userId: string, field: string, value: any): Promise<void> {
    const existing = await db.select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.userId, userId))
      .limit(1);

    const now = new Date();

    if (existing.length === 0) {
      // Create a default row first, then update
      const row: any = {
        id: uuidv4(),
        userId,
        createdAt: now,
        updatedAt: now,
      };
      row[field] = value;
      // Fill defaults
      if (!row.theme) row.theme = 'light';
      if (!row.language) row.language = 'en';
      if (!row.currency) row.currency = 'USD';
      if (!row.aiMode) row.aiMode = 'co-pilot';
      await db.insert(schema.userSettings).values(row);
      return;
    }

    await db.update(schema.userSettings)
      .set({ [field]: value, updatedAt: now })
      .where(eq(schema.userSettings.userId, userId));
  }

  /**
   * Bulk sync the full client state (batch update).
   * This is called on app init / page load to mirror localStorage to the backend.
   */
  async bulkSync(userId: string, fullState: UserSettingsDTO): Promise<UserSettingsDTO> {
    return this.saveSettings(userId, fullState);
  }

  /**
   * Hydrate: fetch settings for a user on login/initialization.
   * Returns defaults merged with any saved data.
   */
  async hydrateOnLogin(userId: string): Promise<UserSettingsDTO> {
    const settings = await this.getSettings(userId);
    return { ...this.getDefaults(), ...settings };
  }

  // ─── PRIVATE HELPERS ──────────────────────────────────────────────────

  private mapRowToDTO(row: any): UserSettingsDTO {
    return {
      businessAngle: row.businessAngle ?? undefined,
      businessNiche: row.businessNiche ?? undefined,
      isOnboarded: row.onboardingComplete ?? false,
      isLinkingComplete: row.linkingComplete ?? false,
      isPaid: false, // derived from payment system, not stored in settings
      onboardingComplete: row.onboardingComplete ?? false,
      linkingComplete: row.linkingComplete ?? false,
      notificationModalDismissed: row.notificationModalDismissed ?? false,
      platformPermissions: row.platformPermissions ?? undefined,
      connectedPlatforms: row.connectedPlatforms ?? undefined,
      theme: row.theme ?? 'light',
      language: row.language ?? 'en',
      currency: row.currency ?? 'USD',
      aiMode: (row.aiMode as 'co-pilot' | 'empire') ?? 'co-pilot',
      autoSendRetention: row.autoSendRetention ?? false,
      notificationSettings: row.notificationSettings ?? { sales: true, approvals: true },
    };
  }

  private getDefaults(): UserSettingsDTO {
    return {
      isOnboarded: false,
      isLinkingComplete: false,
      isPaid: false,
      onboardingComplete: false,
      linkingComplete: false,
      notificationModalDismissed: false,
      connectedPlatforms: [],
      platformPermissions: {},
      theme: 'light',
      language: 'en',
      currency: 'USD',
      aiMode: 'co-pilot',
      autoSendRetention: false,
      notificationSettings: { sales: true, approvals: true },
    };
  }
}

export const userSettingsService = new UserSettingsService();