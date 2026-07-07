import { Router } from 'express';
import { cinemaController, upload } from '../controllers/cinemaController.js';

const router = Router();

/**
 * Cinema Hub Routes — Secure Upload & Neural Twin Generation
 */

// Upload facial photo for Neural Twin (max 10MB)
router.post('/upload-photo', upload.single('photo'), (req, res) =>
  cinemaController.uploadPhoto(req, res)
);

// Upload raw video material for AI editing (max 200MB)
router.post('/upload-video', upload.single('video'), (req, res) =>
  cinemaController.uploadVideo(req, res)
);

// Enhance uploaded video with Empire Style
router.post('/enhance-video', (req, res) =>
  cinemaController.enhanceVideo(req, res)
);

// Create Neural Twin video from photo + script
router.post('/create-twin', (req, res) =>
  cinemaController.createNeuralTwin(req, res)
);

// Generate video from text idea (Gemini → DALL-E/Sharp/FFmpeg pipeline)
router.post('/generate-video', (req, res) =>
  cinemaController.generateVideo(req, res)
);

// Get daily usage remaining
router.get('/usage', (req, res) =>
  cinemaController.getUsage(req, res)
);

// Check asset status
router.get('/status/:assetId', (req, res) =>
  cinemaController.getAssetStatus(req, res)
);

// Get user's creations (for Operations Base display)
router.get('/creations', (req, res) =>
  cinemaController.getCreations(req, res)
);

export default router;