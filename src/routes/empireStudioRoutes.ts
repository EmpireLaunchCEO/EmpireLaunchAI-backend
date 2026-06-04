import { Router } from 'express';
import { empireStudioController } from '../controllers/empireStudioController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

// Create master asset and distribute to platforms
router.post('/create', mobileAuth, empireStudioController.create);

// Get assets for a specific campaign
router.get('/assets/campaign/:campaignId', mobileAuth, empireStudioController.getCampaignAssets);

// Get all user assets
router.get('/assets', mobileAuth, empireStudioController.getUserAssets);

// Get a single asset by ID
router.get('/assets/:assetId', mobileAuth, empireStudioController.getAssetById);

// Generate a VisualSummary preview from DNA strand IDs or raw manifest
router.post('/preview', mobileAuth, empireStudioController.getPreview);

export default router;