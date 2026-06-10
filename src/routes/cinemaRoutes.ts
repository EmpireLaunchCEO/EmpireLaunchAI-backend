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

// Create Neural Twin video from photo + script
router.post('/create-twin', (req, res) =>
  cinemaController.createNeuralTwin(req, res)
);

// Check asset status
router.get('/status/:assetId', (req, res) =>
  cinemaController.getAssetStatus(req, res)
);

export default router;