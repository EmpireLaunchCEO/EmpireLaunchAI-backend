import { Request, Response } from 'express';
import { protectedButtonService } from '../services/protectedButtonService.js';

export class ProtectedButtonController {
  /**
   * POST /api/payment-buttons/protected/generate
   * Generates a protected button URL
   */
  async generate(req: Request, res: Response) {
    try {
      const userId = (req as any).userId || req.body.userId;
      const { productId, platform, isSingleUse } = req.body;
      
      if (!userId || !productId || !platform) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const url = await protectedButtonService.generateButton(userId, productId, platform, isSingleUse);
      
      res.status(201).json({
        status: 'success',
        proxyUrl: url
      });
    } catch (error: any) {
      console.error('[ProtectedButtonController] Generate error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * GET /api/payment-buttons/protected/resolve/:buttonId
   * Resolves a proxy click to a Stripe session
   */
  async resolve(req: Request, res: Response) {
    try {
      const { buttonId } = req.params;
      const { ott } = req.query;

      if (!buttonId || !ott) {
        return res.status(400).json({ error: 'Missing buttonId or ott' });
      }

      const context = {
        userAgent: (req.headers['user-agent'] as string) || 'unknown',
        referrer: (req.headers['referer'] as string) || 'unknown',
        ip: req.ip || 'unknown'
      };

      const providedOtt = Array.isArray(ott) ? String(ott[0]) : String(ott);
      const stripeUrl = await protectedButtonService.resolveProxy(buttonId, providedOtt, context);
      
      if (!stripeUrl) {
        throw new Error('Could not resolve payment URL');
      }

      // Redirect to the Stripe Checkout session
      res.redirect(stripeUrl);
    } catch (error: any) {
      console.error('[ProtectedButtonController] Resolve error:', error);
      res.status(403).json({ error: error.message });
    }
  }
}

export const protectedButtonController = new ProtectedButtonController();
