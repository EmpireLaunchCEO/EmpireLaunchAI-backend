import { Request, Response } from 'express';
import { userSettingsService, UserSettingsDTO } from '../services/userSettingsService.js';

export class UserSettingsController {
  /**
   * GET /api/settings
   * Fetch the user's settings.
   */
  async getSettings(req: Request, res: Response) {
    const userId = (req as any).userId;
    try {
      const settings = await userSettingsService.getSettings(userId);
      res.json(settings);
    } catch (error: any) {
      console.error('[UserSettingsController] getSettings error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * PUT /api/settings
   * Save/upsert user settings.
   */
  async saveSettings(req: Request, res: Response) {
    const userId = (req as any).userId;
    const settings: Partial<UserSettingsDTO> = req.body;

    try {
      const result = await userSettingsService.saveSettings(userId, settings);
      res.json(result);
    } catch (error: any) {
      console.error('[UserSettingsController] saveSettings error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * PATCH /api/settings/:field
   * Update a single settings field incrementally.
   */
  async updateField(req: Request, res: Response) {
    const userId = (req as any).userId;
    const { field } = req.params;
    const { value } = req.body;

    // Validate the field against known column names to prevent injection
    const allowedFields = [
      'businessAngle', 'businessNiche', 'theme', 'language', 'currency',
      'aiMode', 'autoSendRetention', 'onboardingComplete', 'linkingComplete',
      'notificationModalDismissed', 'platformPermissions', 'connectedPlatforms',
      'notificationSettings',
    ];

    if (!allowedFields.includes(field)) {
      return res.status(400).json({ error: `Invalid field: ${field}` });
    }

    try {
      await userSettingsService.updateField(userId, field, value);
      const settings = await userSettingsService.getSettings(userId);
      res.json(settings);
    } catch (error: any) {
      console.error('[UserSettingsController] updateField error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/settings/sync
   * Full bulk sync from client localStorage.
   */
  async bulkSync(req: Request, res: Response) {
    const userId = (req as any).userId;
    const fullState: UserSettingsDTO = req.body;

    try {
      const result = await userSettingsService.bulkSync(userId, fullState);
      res.json(result);
    } catch (error: any) {
      console.error('[UserSettingsController] bulkSync error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/settings/hydrate
   * Fetch settings on login/initialization. Returns defaults merged with saved.
   */
  async hydrateOnLogin(req: Request, res: Response) {
    const userId = (req as any).userId;
    try {
      const settings = await userSettingsService.hydrateOnLogin(userId);
      res.json(settings);
    } catch (error: any) {
      console.error('[UserSettingsController] hydrateOnLogin error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

export const userSettingsController = new UserSettingsController();