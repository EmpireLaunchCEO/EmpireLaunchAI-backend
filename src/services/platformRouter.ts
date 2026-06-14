import { etsyService } from './etsyService.js';
import { canvaService } from './canvaService.js';
import { tiktokService } from './tiktokService.js';
import { shopifyService } from './shopifyService.js';
import { neuralBrowserService, AutomationStep } from './neuralBrowserService.js';
import { integrationService } from './integrationService.js';
import { metaService } from './metaService.js';
import { pinterestService } from './pinterestService.js';
import { youtubeService } from './youtubeService.js';
import { systemeIoService } from './systemeIoService.js';
import { goDaddyService } from './goDaddyService.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean;
  data?: any;
  error?: string;
  externalId?: string;
}

export type DecisionToRoute = {
  type: string;
  userId?: string;
  [key: string]: any;
};

// ─── Platform Router ────────────────────────────────────────────────────────

export class PlatformRouter {
  private platformHandlers: Map<string, (action: string, params: any) => Promise<ExecutionResult>> = new Map();

  constructor() {
    this.registerPlatforms();
  }

  private registerPlatforms(): void {
    // ── Commerce / Listings ──
    this.register('etsy', async (a, p) => this.handleEtsy(a, p));
    this.register('etsy_shop', async (a, p) => this.handleEtsy(a, p));
    this.register('shopify', async (a, p) => this.handleShopify(a, p));

    // ── Social / Content ──
    this.register('tiktok', async (a, p) => this.handleTikTok(a, p));
    this.register('tiktok_shop', async (a, p) => this.handleTikTok(a, p));
    this.register('instagram', async (a, p) => this.handleSocial('instagram', a, p));
    this.register('facebook', async (a, p) => this.handleSocial('facebook', a, p));
    this.register('youtube', async (a, p) => this.handleSocial('youtube', a, p));
    this.register('pinterest', async (a, p) => this.handleSocial('pinterest', a, p));
    this.register('fiverr', async (a, p) => this.handleSocial('fiverr', a, p));

    // ── Content Creation (API-enabled) ──
    this.register('canva', async (a, p) => this.handleCanva(a, p));

    // ── Content Creation (Browser-automated — no public API) ──
    this.register('kittl', async (a, p) => this.handleBrowserPlatform('kittl', a, p));
    this.register('capcut', async (a, p) => this.handleBrowserPlatform('capcut', a, p));

    // ── Browser Automation Agent ──
    this.register('neural_browser', async (a, p) => this.handleNeuralBrowser(a, p));

    // ── Financial / Communication ──
    this.register('stripe', async (a, p) => this.handleFinancial('stripe', a, p));
    this.register('paypal', async (a, p) => this.handleFinancial('paypal', a, p));
    this.register('gmail', async (a, p) => this.handleCommunication('gmail', a, p));
    this.register('outlook', async (a, p) => this.handleCommunication('outlook', a, p));

    // ── Email Marketing / Domains ──
    this.register('systeme_io', async (a, p) => this.handleSystemeIo(a, p));
    this.register('godaddy', async (a, p) => this.handleGoDaddy(a, p));
  }

  private register(name: string, handler: (action: string, params: any) => Promise<ExecutionResult>): void {
    this.platformHandlers.set(name, handler);
  }

  /**
   * Route a decision to the appropriate platform(s) for execution.
   */
  async route(decision: DecisionToRoute): Promise<ExecutionResult> {
    switch (decision.type) {
      case 'RESEARCH': {
        const { platforms = [], niche, userId } = decision;
        const results: ExecutionResult[] = [];
        for (const platform of platforms) {
          const handler = this.platformHandlers.get(platform);
          if (handler) {
            results.push(await handler('research', { niche, userId }));
          }
        }
        return { success: results.every(r => r.success), data: { results, niche, platforms } };
      }

      case 'CREATE_CONTENT': {
        const { platform = 'canva', taskId, userId = 'system' } = decision;
        const handler = this.findContentHandler(platform);
        if (!handler) return { success: false, error: `No content platform available for: ${platform}` };
        return handler('create', { taskId, userId });
      }

      case 'DRAFT_LISTING': {
        const { platform = 'etsy', productName, userId = 'system' } = decision;
        const handler = this.platformHandlers.get(platform);
        if (!handler) return { success: false, error: `No listing platform available for: ${platform}` };
        return handler('create_listing', { productName, userId });
      }

      case 'SCHEDULE_POST': {
        const { platforms = ['tiktok', 'instagram'], assetId, userId = 'system' } = decision;
        const results: ExecutionResult[] = [];
        for (const platform of platforms) {
          const handler = this.platformHandlers.get(platform);
          if (handler) results.push(await handler('schedule_post', { assetId, userId }));
        }
        return { success: results.every(r => r.success), data: { results, assetId } };
      }

      case 'MONITOR_PERFORMANCE': {
        const { assetIds = [], userId = 'system' } = decision;
        const results: ExecutionResult[] = [];
        for (const platform of ['etsy', 'tiktok', 'instagram']) {
          const handler = this.platformHandlers.get(platform);
          if (handler) results.push(await handler('get_analytics', { assetIds, userId }));
        }
        return { success: true, data: { results, assetIds } };
      }

      case 'OPTIMIZE_STRATEGY':
        return { success: true, data: { reason: decision.reason, action: 'strategy_optimization_queued' } };
      case 'WAIT_FOR_APPROVAL':
        return { success: true, data: { approvalId: decision.approvalId, status: 'waiting_for_user' } };
      case 'SELF_CORRECT':
        return { success: true, data: { taskId: decision.taskId, diagnosis: decision.diagnosis, action: 'self_correction_queued' } };
      case 'NOTIFY_USER':
        return { success: true, data: { message: decision.message, severity: decision.severity } };
      case 'NO_ACTION':
        return { success: true, data: { reason: decision.reason } };
      default:
        return { success: false, error: `Unknown decision type: ${(decision as any).type}` };
    }
  }

  // ─── Platform Handlers ──────────────────────────────────────────────────

  private async handleEtsy(action: string, params: any): Promise<ExecutionResult> {
    try {
      const { userId } = params;
      switch (action) {
        case 'research':
        case 'search_trends': {
          const listings = await etsyService.searchListings(params.niche || 'trending', 10);
          return { success: true, data: { listings, niche: params.niche } };
        }
        case 'create_listing': {
          const creds = await integrationService.getCredentials(userId, 'etsy');
          if (!creds) return { success: false, error: 'Etsy not connected' };
          const listing = await etsyService.createListing(creds.access_token, creds.shop_id, {
            title: params.productName || 'AI-Generated Product',
            description: `AI-generated listing for ${params.productName}`,
            price: 9.99,
            quantity: 1,
          });
          return { success: true, data: { listing }, externalId: listing?.listing_id?.toString() };
        }
        case 'get_analytics': {
          const creds = await integrationService.getCredentials(userId, 'etsy');
          if (!creds) return { success: false, error: 'Etsy not connected' };
          const stats = await etsyService.getGrowthStats(creds.access_token, creds.shop_id);
          return { success: true, data: { stats } };
        }
        default: return { success: false, error: `Unknown Etsy action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, error: `Etsy error: ${error.message}` };
    }
  }

  private async handleCanva(action: string, params: any): Promise<ExecutionResult> {
    try {
      const { userId = 'system' } = params;
      switch (action) {
        case 'research':
        case 'search_trends': {
          const templates = await canvaService.searchTemplates(userId, 'modern', params.niche || 'general');
          return { success: true, data: { templates, niche: params.niche } };
        }
        case 'create': {
          const templates = await canvaService.searchTemplates(userId, 'modern', params.niche || 'digital product');
          if (templates.length === 0) return { success: false, error: 'No templates found' };
          const designId = await canvaService.createFromTemplate(userId, templates[0], { title: params.taskId || 'AI Design' });
          return { success: true, data: { designId, templateId: templates[0] }, externalId: designId };
        }
        case 'export': {
          const url = await canvaService.exportDesign(userId, params.designId);
          return { success: true, data: { exportUrl: url } };
        }
        default: return { success: false, error: `Unknown Canva action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, error: `Canva error: ${error.message}` };
    }
  }

  private async handleTikTok(action: string, params: any): Promise<ExecutionResult> {
    try {
      const { userId = 'system' } = params;
      switch (action) {
        case 'research':
        case 'search_trends':
          return { success: true, data: { niche: params.niche, suggestedHashtags: [`#${params.niche}`, `#${params.niche}Tok`] } };
        case 'schedule_post': {
          const result = await tiktokService.publishVideo(userId, params.assetId || params.videoUrl, 'New post from Empire Launch AI', params.caption || '');
          return { success: true, data: { result } };
        }
        case 'get_analytics': {
          const analytics = await tiktokService.getVideoAnalytics(userId);
          return { success: true, data: { analytics } };
        }
        default: return { success: false, error: `Unknown TikTok action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, error: `TikTok error: ${error.message}` };
    }
  }

  private async handleShopify(action: string, params: any): Promise<ExecutionResult> {
    try {
      const { userId } = params;
      const creds = await integrationService.getCredentials(userId, 'shopify');
      if (!creds) return { success: false, error: 'Shopify not connected' };
      switch (action) {
        case 'create_listing': {
          const result = await shopifyService.createListing(creds.shop_name || creds.subdomain, creds.access_token, {
            title: params.productName || 'New Product',
            body_html: `<p>${params.productName || 'AI product'}</p>`,
            vendor: 'Empire Launch AI',
            product_type: 'Digital',
            variants: [{ price: '9.99' }],
          });
          return { success: true, data: { shopifyProduct: result }, externalId: result?.id?.toString() };
        }
        default: return { success: false, error: `Unknown Shopify action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, error: `Shopify error: ${error.message}` };
    }
  }

  private async handleSocial(platform: string, action: string, params: any): Promise<ExecutionResult> {
    try {
      const { userId = 'system' } = params;
      switch (action) {
        case 'research':
        case 'search_trends':
          return { success: true, data: { platform, niche: params.niche } };
        case 'schedule_post': {
          if (platform === 'instagram' || platform === 'facebook') {
            const result = await metaService.publishPost(userId, { ...params, platform });
            return { success: true, data: { platform, result } };
          }
          if (platform === 'pinterest') {
            const result = await pinterestService.publishPost(userId, params);
            return { success: true, data: { platform, result } };
          }
          if (platform === 'youtube') {
            const result = await youtubeService.publishShorts(userId, params.assetId || params.videoUrl, 'New short', params.caption || '');
            return { success: true, data: { platform, result } };
          }

          const steps: AutomationStep[] = [
            { action: 'navigate', url: `https://www.${platform}.com/create/post` },
            { action: 'wait', value: 'body' },
            { action: 'approve', value: `Post to ${platform} requires manual confirmation` },
          ];
          return { success: true, data: { platform, steps } };
        }
        default: return { success: true, data: { platform, action } };
      }
    } catch (error: any) {
      return { success: false, error: `${platform} error: ${error.message}` };
    }
  }

  private async handleBrowserPlatform(platform: string, action: string, params: any): Promise<ExecutionResult> {
    try {
      const { userId = 'system' } = params;
      let steps: AutomationStep[];
      switch (action) {
        case 'research':
        case 'search_trends':
          steps = [
            { action: 'navigate', url: platform === 'kittl' ? 'https://www.kittl.com/templates' : 'https://www.capcut.com/templates' },
            { action: 'wait', value: 'body' },
            { action: 'extract', selector: '.template-card' },
          ];
          break;
        case 'create':
          steps = [
            { action: 'navigate', url: platform === 'kittl' ? 'https://www.kittl.com/create' : 'https://www.capcut.com/editor' },
            { action: 'wait', value: 'body' },
            { action: 'approve', value: `${platform} design requires manual review` },
          ];
          break;
        default:
          return { success: true, data: { platform, action } };
      }
      const results = await neuralBrowserService.executeAutomation(userId, steps);
      return { success: true, data: { platform, results } };
    } catch (error: any) {
      return { success: false, error: `${platform} error: ${error.message}` };
    }
  }

  private async handleNeuralBrowser(action: string, params: any): Promise<ExecutionResult> {
    try {
      const results = await neuralBrowserService.executeAutomation(params.userId || 'system', params.steps || []);
      return { success: true, data: { results } };
    } catch (error: any) {
      return { success: false, error: `Neural Browser error: ${error.message}` };
    }
  }

  private async handleFinancial(_platform: string, _action: string, _params: any): Promise<ExecutionResult> {
    return { success: true, data: { note: 'Financial ops require manual approval' } };
  }

  private async handleCommunication(_platform: string, _action: string, _params: any): Promise<ExecutionResult> {
    return { success: true, data: { note: 'Communication routed to inbox assistant' } };
  }

  private async handleSystemeIo(action: string, params: any): Promise<ExecutionResult> {
    try {
      const { userId = 'system' } = params;
      switch (action) {
        case 'onboarding': {
          const result = await systemeIoService.setupAutoCampaign(userId, params.niche);
          return { success: true, data: { result } };
        }
        default: return { success: false, error: `Unknown Systeme.io action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, error: `Systeme.io error: ${error.message}` };
    }
  }

  private async handleGoDaddy(action: string, params: any): Promise<ExecutionResult> {
    try {
      const { userId = 'system' } = params;
      switch (action) {
        case 'onboarding': {
          const result = await goDaddyService.setupDnsRecords(userId, params.domain);
          return { success: true, data: { result } };
        }
        default: return { success: false, error: `Unknown GoDaddy action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, error: `GoDaddy error: ${error.message}` };
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private findContentHandler(preferred: string): ((action: string, params: any) => Promise<ExecutionResult>) | undefined {
    const order = ['canva', 'kittl', 'capcut'];
    if (this.platformHandlers.has(preferred)) return this.platformHandlers.get(preferred)!;
    for (const name of order) {
      if (this.platformHandlers.has(name)) return this.platformHandlers.get(name)!;
    }
    return undefined;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _routerInstance: PlatformRouter | null = null;

export function getRouter(): PlatformRouter {
  if (!_routerInstance) _routerInstance = new PlatformRouter();
  return _routerInstance;
}
