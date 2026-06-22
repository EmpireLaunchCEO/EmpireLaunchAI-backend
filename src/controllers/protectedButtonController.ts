import { Request, Response } from 'express';
import { protectedButtonService } from '../services/protectedButtonService.js';

export class ProtectedButtonController {
  /**
   * Generates a protected button URL.
   */
  async generate(req: Request, res: Response) {
    try {
      const userId = req.headers['x-user-id'] as string || 'default-user';
      const { productId, platform, isSingleUse, contentId, campaignId } = req.body;

      if (!productId) {
        return res.status(400).json({ error: 'Missing productId' });
      }

      const proxyUrl = await protectedButtonService.generateButton(
        userId, 
        productId, 
        platform || 'general', 
        isSingleUse,
        contentId,
        campaignId
      );
      
      res.json({ proxyUrl });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Resolves a protected button click.
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
        referrer: (req.headers['referer'] as string) || 'direct',
        ip: req.ip || 'unknown'
      };

      let ottValue: string = '';
      if (typeof ott === 'string') {
        ottValue = ott;
      } else if (Array.isArray(ott) && typeof ott[0] === 'string') {
        ottValue = ott[0];
      }

      if (!ottValue) {
        return res.status(400).json({ error: 'Invalid or missing ott' });
      }

      const redirectUrl = await protectedButtonService.resolveProxy(buttonId as string, ottValue as string, context);
      
      if (redirectUrl) {
          res.redirect(redirectUrl);
      } else {
          throw new Error('Could not resolve redirect URL');
      }
    } catch (error: any) {
      console.error(`[ProtectedButtonController] Error: \${error.message}`);
      res.status(400).send(`<html><body><h1>Security Verification Failed</h1><p>\${error.message}</p></body></html>`);
    }
  }

  /**
   * resolveProxy - Alias for resolve as per task requirement.
   */
  async resolveProxy(req: Request, res: Response) {
    return this.resolve(req, res);
  }
}

export const protectedButtonController = new ProtectedButtonController();
