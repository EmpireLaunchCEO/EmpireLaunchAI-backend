import { Router } from 'express';
import { mobileAuth } from '../middleware/mobileAuth.js';
import { neuralActionEngine } from '../services/neuralActionEngine.js';

const router = Router();

/**
 * POST /api/actions/:action
 * Execute a named action pipeline via the Neural Action Engine.
 * Dispatches to the correct pipeline based on the action name.
 *
 * Body params vary by action:
 *  - post-tiktok: { videoPath, caption?, music?, hashtags? }
 *  - post-instagram-reel: { videoPath, caption?, coverImagePath?, music?, hashtags? }
 *  - post-instagram: { imagePath, caption? }
 *  - create-etsy-listing: { title, description, price, images?, category?, tags? }
 *  - create-shopify-product: { title, description, price, images?, vendor?, productType?, tags? }
 *  - create-facebook-post: { text, imagePath? }
 *  - create-pinterest-pin: { imagePath, title, description, link? }
 *  - upload-youtube: { videoPath, title, description, tags? }
 *  - setup-godaddy-dns: { domain, records: [{type, name, value, ttl?}] }
 */
router.post('/:action', mobileAuth, async (req: any, res: any) => {
  const userId = req.userId || req.body.userId;
  if (!userId) {
    return res.status(401).json({ error: 'User ID required' });
  }

  const { action } = req.params;
  const params = req.body;

  try {
    const result = await neuralActionEngine.executePipeline(userId, action, params);
    res.json({ status: 'success', action, result });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

export default router;