import { Router } from 'express';
import { empireStudioController } from '../controllers/empireStudioController.js';
import { studioVaultController } from '../controllers/studioVaultController.js';
import { mobileAuth } from '../middleware/mobileAuth.js';

const router = Router();

// Create master asset and distribute to platforms
router.post('/create', mobileAuth, empireStudioController.create);

// Conversational Consultant chat
router.post('/chat', mobileAuth, empireStudioController.chat);

// Cinema Engine: Create Neural Twin
router.post('/cinema/twin', mobileAuth, empireStudioController.createNeuralTwin);

// Get assets for a specific campaign
router.get('/assets/campaign/:campaignId', mobileAuth, empireStudioController.getCampaignAssets);

// Get all user assets
router.get('/assets', mobileAuth, empireStudioController.getUserAssets);

// Get a single asset by ID
router.get('/assets/:assetId', mobileAuth, empireStudioController.getAssetById);

// Generate a VisualSummary preview from DNA strand IDs or raw manifest
router.post('/preview', mobileAuth, empireStudioController.getPreview);

// ─── STUDIO VAULT (Inspiration Gallery) ────────────────────────────────

// Get synthesized vault strands for the Studio page
// Supports ?category=layout&limit=20&minScore=70
router.get('/vault', mobileAuth, studioVaultController.getSynthesizedStrands);

// Search vault by niche or category
router.get('/vault/search', mobileAuth, studioVaultController.searchVault);

export default router;