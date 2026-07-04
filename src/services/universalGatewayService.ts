import axios from 'axios';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { integrationService } from './integrationService.js';
import { vaultService } from './vaultService.js';

/**
 * Universal Gateway Service
 * 
 * Production-ready OAuth 2.0 flows for all integrated platforms.
 * Each platform follows the same PKCE security pattern established by Etsy:
 * 1. Generate state + codeVerifier → store in oauthSessions table
 * 2. Return auth URL + state + sessionId (codeVerifier NEVER leaves server)
 * 3. Callback validates state, expiry, replay, user binding
 * 4. Retrieve codeVerifier from DB → exchange for tokens
 * 5. Save tokens via integrationService
 */

export interface OAuthConfig {
  platform: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  usePKCE: boolean;
  clientId: () => string;
  clientSecret: () => string;
  redirectUri: () => string;
  extraAuthParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  tokenHeaders?: Record<string, string>;
  responseType?: string;
}

class UniversalGatewayService {
  private configs: OAuthConfig[];

  constructor() {
    this.configs = this.defineConfigs();
  }

  /**
   * All platform OAuth configurations in one place.
   */
  private defineConfigs(): OAuthConfig[] {
    return [
      // ─── TIKTOK ────────────────────────────────────────────────
      {
        platform: 'tiktok',
        authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
        tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
        scopes: ['user.info.basic', 'video.list', 'video.upload', 'video.publish'],
        usePKCE: true,
        clientId: () => process.env.TIKTOK_CLIENT_ID || '',
        clientSecret: () => process.env.TIKTOK_CLIENT_SECRET || '',
        redirectUri: () => process.env.TIKTOK_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
        tokenHeaders: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      },

      // ─── TIKTOK SHOP ───────────────────────────────────────────
      {
        platform: 'tiktok_shop',
        authUrl: 'https://auth.tiktok-shops.com/api/v2/token/get',
        tokenUrl: 'https://open-api.tiktokglobalshop.com/api/v2/token/refresh',
        scopes: ['product.list', 'order.list', 'fulfillment.read'],
        usePKCE: true,
        clientId: () => process.env.TIKTOK_SHOP_CLIENT_ID || '',
        clientSecret: () => process.env.TIKTOK_SHOP_CLIENT_SECRET || '',
        redirectUri: () => process.env.TIKTOK_SHOP_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code', service_type: '1' },
        extraTokenParams: { grant_type: 'authorization_code' },
        tokenHeaders: { 'Content-Type': 'application/json' },
      },

      // ─── META (Instagram & Facebook) ───────────────────────────
      {
        platform: 'meta',
        authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
        tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
        scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'],
        usePKCE: false, // Meta doesn't support PKCE, uses state-only
        clientId: () => process.env.META_CLIENT_ID || '',
        clientSecret: () => process.env.META_CLIENT_SECRET || '',
        redirectUri: () => process.env.META_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── PINTEREST ─────────────────────────────────────────────
      {
        platform: 'pinterest',
        authUrl: 'https://www.pinterest.com/oauth/',
        tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
        scopes: ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'],
        usePKCE: true,
        clientId: () => process.env.PINTEREST_CLIENT_ID || '',
        clientSecret: () => process.env.PINTEREST_CLIENT_SECRET || '',
        redirectUri: () => process.env.PINTEREST_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
        tokenHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      // ─── CANVA ─────────────────────────────────────────────────
      {
        platform: 'canva',
        authUrl: 'https://www.canva.com/api/oauth/v1/authorize',
        tokenUrl: 'https://api.canva.com/v1/oauth/token',
        scopes: ['canva:design:read', 'canva:autofill:write', 'canva:export:write'],
        usePKCE: true,
        clientId: () => process.env.CANVA_CLIENT_ID || '',
        clientSecret: () => process.env.CANVA_CLIENT_SECRET || '',
        redirectUri: () => process.env.CANVA_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
        tokenHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },

      // ─── SHOPIFY ───────────────────────────────────────────────
      {
        platform: 'shopify',
        authUrl: 'https://{shop}.myshopify.com/admin/oauth/authorize',
        tokenUrl: 'https://{shop}.myshopify.com/admin/oauth/access_token',
        scopes: ['read_products', 'write_products', 'read_orders', 'read_customers'],
        usePKCE: false,
        clientId: () => process.env.SHOPIFY_CLIENT_ID || '',
        clientSecret: () => process.env.SHOPIFY_CLIENT_SECRET || '',
        redirectUri: () => process.env.SHOPIFY_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
      },

      // ─── WOOCOMMERCE ────────────────────────────────────────────
      {
        platform: 'woocommerce',
        authUrl: 'https://{domain}/oauth/authorize',
        tokenUrl: 'https://{domain}/oauth/token',
        scopes: ['read', 'write', 'read_orders', 'write_orders', 'read_products', 'write_products'],
        usePKCE: true,
        clientId: () => process.env.WOOCOMMERCE_CLIENT_ID || '',
        clientSecret: () => process.env.WOOCOMMERCE_CLIENT_SECRET || '',
        redirectUri: () => process.env.WOOCOMMERCE_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── SHIPSTATION ───────────────────────────────────────────
      {
        platform: 'shipstation',
        authUrl: 'https://api.shipstation.com/oauth/authorize',
        tokenUrl: 'https://api.shipstation.com/oauth/token',
        scopes: ['read', 'write', 'orders', 'products'],
        usePKCE: true,
        clientId: () => process.env.SHIPSTATION_CLIENT_ID || '',
        clientSecret: () => process.env.SHIPSTATION_CLIENT_SECRET || '',
        redirectUri: () => process.env.SHIPSTATION_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── FIVERR ────────────────────────────────────────────────
      {
        platform: 'fiverr',
        authUrl: 'https://api.fiverr.com/v2/oauth/authorize',
        tokenUrl: 'https://api.fiverr.com/v2/oauth/token',
        scopes: ['read_gigs', 'write_gigs', 'read_orders', 'read_profile'],
        usePKCE: true,
        clientId: () => process.env.FIVERR_CLIENT_ID || '',
        clientSecret: () => process.env.FIVERR_CLIENT_SECRET || '',
        redirectUri: () => process.env.FIVERR_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── GOOGLE (YouTube & Gmail) ──────────────────────────────
      {
        platform: 'google',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: [
          'https://www.googleapis.com/auth/youtube.readonly',
          'https://www.googleapis.com/auth/gmail.send',
          'https://www.googleapis.com/auth/userinfo.email',
          'openid',
        ],
        usePKCE: true,
        clientId: () => process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || '',
        redirectUri: () => process.env.GOOGLE_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code', access_type: 'offline', prompt: 'consent' },
        extraTokenParams: { grant_type: 'authorization_code' },
        tokenHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },

      // ─── MICROSOFT (Outlook) ───────────────────────────────────
      {
        platform: 'microsoft',
        authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        scopes: ['offline_access', 'https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read'],
        usePKCE: true,
        clientId: () => process.env.OUTLOOK_CLIENT_ID || '',
        clientSecret: () => process.env.OUTLOOK_CLIENT_SECRET || '',
        redirectUri: () => process.env.OUTLOOK_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code', response_mode: 'query' },
        extraTokenParams: { grant_type: 'authorization_code' },
        tokenHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },

      // ─── DSers ─────────────────────────────────────────────────
      {
        platform: 'dsers',
        authUrl: 'https://auth.dsers.com/oauth/authorize',
        tokenUrl: 'https://auth.dsers.com/oauth/token',
        scopes: ['product.read', 'order.read', 'fulfillment.write'],
        usePKCE: true,
        clientId: () => process.env.DSERS_CLIENT_ID || '',
        clientSecret: () => process.env.DSERS_CLIENT_SECRET || '',
        redirectUri: () => process.env.DSERS_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── Zendrop ───────────────────────────────────────────────
      {
        platform: 'zendrop',
        authUrl: 'https://app.zendrop.com/oauth/authorize',
        tokenUrl: 'https://api.zendrop.com/oauth/token',
        scopes: ['product.read', 'order.read', 'fulfillment.write'],
        usePKCE: true,
        clientId: () => process.env.ZENDROP_CLIENT_ID || '',
        clientSecret: () => process.env.ZENDROP_CLIENT_SECRET || '',
        redirectUri: () => process.env.ZENDROP_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── Spocket ───────────────────────────────────────────────
      {
        platform: 'spocket',
        authUrl: 'https://www.spocket.co/oauth/authorize',
        tokenUrl: 'https://api.spocket.co/v1/oauth/token',
        scopes: ['product.read', 'order.create'],
        usePKCE: true,
        clientId: () => process.env.SPOCKET_CLIENT_ID || '',
        clientSecret: () => process.env.SPOCKET_CLIENT_SECRET || '',
        redirectUri: () => process.env.SPOCKET_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── Printful ──────────────────────────────────────────────
      {
        platform: 'printful',
        authUrl: 'https://www.printful.com/oauth/authorize',
        tokenUrl: 'https://api.printful.com/oauth/token',
        scopes: ['sync_products', 'sync_orders', 'store_info'],
        usePKCE: true,
        clientId: () => process.env.PRINTFUL_CLIENT_ID || '',
        clientSecret: () => process.env.PRINTFUL_CLIENT_SECRET || '',
        redirectUri: () => process.env.PRINTFUL_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── Printify ──────────────────────────────────────────────
      {
        platform: 'printify',
        authUrl: 'https://connect.printify.com/oauth/authorize',
        tokenUrl: 'https://api.printify.com/v1/oauth/token',
        scopes: ['products:read', 'products:write', 'orders:read', 'orders:write', 'shops:read'],
        usePKCE: true,
        clientId: () => process.env.PRINTIFY_CLIENT_ID || '',
        clientSecret: () => process.env.PRINTIFY_CLIENT_SECRET || '',
        redirectUri: () => process.env.PRINTIFY_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── CJ Dropshipping ───────────────────────────────────────
      {
        platform: 'cj_dropshipping',
        authUrl: 'https://oauth.cjdropshipping.com/authorize',
        tokenUrl: 'https://api.cjdropshipping.com/oauth/token',
        scopes: ['product.read', 'order.read', 'order.write', 'fulfillment.read'],
        usePKCE: true,
        clientId: () => process.env.CJ_CLIENT_ID || '',
        clientSecret: () => process.env.CJ_CLIENT_SECRET || '',
        redirectUri: () => process.env.CJ_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── AutoDS ────────────────────────────────────────────────
      {
        platform: 'autods',
        authUrl: 'https://app.autods.com/oauth/authorize',
        tokenUrl: 'https://api.autods.com/oauth/token',
        scopes: ['product.read', 'order.read', 'fulfillment.write', 'pricing.read'],
        usePKCE: true,
        clientId: () => process.env.AUTODS_CLIENT_ID || '',
        clientSecret: () => process.env.AUTODS_CLIENT_SECRET || '',
        redirectUri: () => process.env.AUTODS_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
      },

      // ─── ETSY ──────────────────────────────────────────────────
      {
        platform: 'etsy',
        authUrl: 'https://www.etsy.com/oauth/connect',
        tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
        scopes: ['listings_r', 'listings_w', 'listings_d', 'shops_r', 'shops_w', 'transactions_r', 'transactions_w'],
        usePKCE: true,
        clientId: () => process.env.ETSY_CLIENT_ID || '',
        clientSecret: () => process.env.ETSY_CLIENT_SECRET || '',
        redirectUri: () => process.env.ETSY_REDIRECT_URI || '',
        extraAuthParams: { response_type: 'code' },
        extraTokenParams: { grant_type: 'authorization_code' },
        tokenHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },

        // ─── AMAZON ────────────────────────────────────────────────
        {
          platform: 'amazon',
          authUrl: 'https://www.amazon.com/ap/oa',
          tokenUrl: 'https://api.amazon.com/auth/o2/token',
          scopes: ['profile', 'spapi:listings'],
          usePKCE: true,
          clientId: () => process.env.AMAZON_CLIENT_ID || '',
          clientSecret: () => process.env.AMAZON_CLIENT_SECRET || '',
          redirectUri: () => process.env.AMAZON_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code' },
          extraTokenParams: { grant_type: 'authorization_code' },
        },

        // ─── EBAY ──────────────────────────────────────────────────
        {
          platform: 'ebay',
          authUrl: 'https://auth.ebay.com/oauth2/authorize',
          tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
          scopes: ['https://api.ebay.com/oauth/api_scope/sell.inventory', 'https://api.ebay.com/oauth/api_scope/sell.fulfillment'],
          usePKCE: true,
          clientId: () => process.env.EBAY_CLIENT_ID || '',
          clientSecret: () => process.env.EBAY_CLIENT_SECRET || '',
          redirectUri: () => process.env.EBAY_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code', prompt: 'login' },
          extraTokenParams: { grant_type: 'authorization_code' },
        },

        // ─── SQUARESPACE ───────────────────────────────────────────
        {
          platform: 'squarespace',
          authUrl: 'https://account.squarespace.com/api/oauth/authorize',
          tokenUrl: 'https://api.squarespace.com/api/v1/oauth/token',
          scopes: ['commerce:read', 'commerce:write', 'content:read', 'content:write'],
          usePKCE: true,
          clientId: () => process.env.SQUARESPACE_CLIENT_ID || '',
          clientSecret: () => process.env.SQUARESPACE_CLIENT_SECRET || '',
          redirectUri: () => process.env.SQUARESPACE_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code' },
          extraTokenParams: { grant_type: 'authorization_code' },
        },

        // ─── WIX ────────────────────────────────────────────────────
        {
          platform: 'wix',
          authUrl: 'https://www.wix.com/oauth/authorize',
          tokenUrl: 'https://www.wix.com/oauth/access',
          scopes: ['online-store.read', 'online-store.write', 'contacts.read'],
          usePKCE: true,
          clientId: () => process.env.WIX_CLIENT_ID || '',
          clientSecret: () => process.env.WIX_CLIENT_SECRET || '',
          redirectUri: () => process.env.WIX_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code' },
          extraTokenParams: { grant_type: 'authorization_code' },
        },

        // ─── GUMROAD ───────────────────────────────────────────────
        {
          platform: 'gumroad',
          authUrl: 'https://gumroad.com/oauth/authorize',
          tokenUrl: 'https://api.gumroad.com/oauth/token',
          scopes: ['sales:read', 'products:read', 'products:write'],
          usePKCE: true,
          clientId: () => process.env.GUMROAD_CLIENT_ID || '',
          clientSecret: () => process.env.GUMROAD_CLIENT_SECRET || '',
          redirectUri: () => process.env.GUMROAD_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code' },
          extraTokenParams: { grant_type: 'authorization_code' },
        },

        // ─── PATREON ───────────────────────────────────────────────
        {
          platform: 'patreon',
          authUrl: 'https://www.patreon.com/oauth2/authorize',
          tokenUrl: 'https://www.patreon.com/api/oauth2/token',
          scopes: ['identity', 'identity.memberships', 'campaigns'],
          usePKCE: true,
          clientId: () => process.env.PATREON_CLIENT_ID || '',
          clientSecret: () => process.env.PATREON_CLIENT_SECRET || '',
          redirectUri: () => process.env.PATREON_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code' },
          extraTokenParams: { grant_type: 'authorization_code' },
        },

        // ─── LINKEDIN ──────────────────────────────────────────────
        {
          platform: 'linkedin',
          authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
          tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
          scopes: ['profile', 'w_member_social', 'rw_organization_admin'],
          usePKCE: true,
          clientId: () => process.env.LINKEDIN_CLIENT_ID || '',
          clientSecret: () => process.env.LINKEDIN_CLIENT_SECRET || '',
          redirectUri: () => process.env.LINKEDIN_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code' },
          extraTokenParams: { grant_type: 'authorization_code' },
        },

        // ─── TWITCH ─────────────────────────────────────────────────
        {
          platform: 'twitch',
          authUrl: 'https://id.twitch.tv/oauth2/authorize',
          tokenUrl: 'https://id.twitch.tv/oauth2/token',
          scopes: ['user:read:email', 'channel:read:stream_key', 'channel:manage:broadcast'],
          usePKCE: true,
          clientId: () => process.env.TWITCH_CLIENT_ID || '',
          clientSecret: () => process.env.TWITCH_CLIENT_SECRET || '',
          redirectUri: () => process.env.TWITCH_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code' },
          extraTokenParams: { grant_type: 'authorization_code' },
        },
        // ─── RAILWAY ────────────────────────────────────────────────
        {
          platform: 'railway',
          authUrl: 'https://railway.com/oauth/authorize',
          tokenUrl: 'https://railway.com/oauth/token',
          scopes: ['read:credits', 'read:projects', 'read:deployments'],
          usePKCE: true,
          clientId: () => process.env.RAILWAY_CLIENT_ID || '',
          clientSecret: () => process.env.RAILWAY_CLIENT_SECRET || '',
          redirectUri: () => process.env.RAILWAY_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code' },
          extraTokenParams: { grant_type: 'authorization_code' },
        },
        // ─── GOOGLE STUDIO (Gemini / Vertex AI) ──────────────────────
        {
          platform: 'google_studio',
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          scopes: [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/generative-language.readonly',
          ],
          usePKCE: true,
          clientId: () => process.env.GOOGLE_CLIENT_ID || '',
          clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || '',
          redirectUri: () => process.env.GOOGLE_REDIRECT_URI || '',
          extraAuthParams: { response_type: 'code', access_type: 'offline', prompt: 'consent' },
          extraTokenParams: { grant_type: 'authorization_code' },
          tokenHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
        ];
  }

  /**
   * Get OAuth config for a specific platform.
   */
  getConfig(platform: string): OAuthConfig | undefined {
    const p = platform.toLowerCase();
    // Support aliases for priority platforms
    if (p === 'instagram') return this.configs.find(c => c.platform === 'meta');
    if (p === 'facebook') return this.configs.find(c => c.platform === 'meta');
    if (p === 'youtube') return this.configs.find(c => c.platform === 'google');
    if (p === 'gmail') return this.configs.find(c => c.platform === 'google');
    
    return this.configs.find(c => c.platform === p);
  }

  /**
   * Get all supported platforms.
   */
  getSupportedPlatforms(): string[] {
    const base = this.configs.map(c => c.platform);
    return [...base, 'instagram', 'facebook', 'youtube', 'gmail'];
  }

  /**
   * Generate the OAuth URL and persist session.
   * Follows the Etsy blueprint: store state+codeVerifier server-side.
   */
  async initiateOAuth(userId: string, platform: string, shopDomain?: string): Promise<{ url: string; state: string; sessionId: string }> {
    const config = this.getConfig(platform);
    if (!config) throw new Error(`Platform ${platform} not supported`);

    const clientId = config.clientId();
    if (!clientId || clientId === 'mock' || clientId.includes('placeholder')) {
      const error = new Error('MISSING_KEYS');
      (error as any).key = `${platform.toUpperCase()}_CLIENT_ID`;
      throw error;
    }

    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // Build auth URL, replacing placeholders
    let authUrl = config.authUrl;
    if (shopDomain) {
      if (platform === 'shopify') authUrl = authUrl.replace('{shop}', shopDomain);
      if (platform === 'woocommerce') authUrl = authUrl.replace('{domain}', shopDomain);
    }
    if (platform === 'woocommerce' && !shopDomain) {
      throw new Error('WooCommerce requires a store domain (shop parameter)');
    }

    const params = new URLSearchParams({
      client_id: config.clientId(),
      redirect_uri: config.redirectUri(),
      scope: config.scopes.join(config.platform === 'meta' ? ',' : ' '),
      state,
      ...config.extraAuthParams,
    });

    if (config.usePKCE) {
      params.append('code_challenge', codeChallenge);
      params.append('code_challenge_method', 'S256');
    }

    const url = `${authUrl}?${params.toString()}`;

    // Persist OAuth session
    const sessionId = uuidv4();
    await db.insert(schema.oauthSessions).values({
      id: sessionId,
      userId,
      platform,
      state,
      codeVerifier,
      used: false,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    });

    return { url, state, sessionId };
  }

  /**
   * Handle OAuth callback for any platform.
   * Same security pattern as Etsy: validate state, retrieve codeVerifier from DB.
   */
  async handleCallback(userId: string | undefined, platform: string, code: string, state: string, sessionId: string, shopDomain?: string): Promise<any> {
    const config = this.getConfig(platform);
    if (!config) throw new Error(`Platform ${platform} not supported`);

    // Retrieve and validate OAuth session
    const [session] = await db.select()
      .from(schema.oauthSessions)
      .where(
        sessionId
          ? and(eq(schema.oauthSessions.id, sessionId), eq(schema.oauthSessions.platform, platform))
          : and(eq(schema.oauthSessions.state, state), eq(schema.oauthSessions.platform, platform))
      )
      .limit(1);

    if (!session) throw new Error('OAuth session not found');
    if (session.used) throw new Error('OAuth session already used');
    if (session.state !== state) throw new Error('State mismatch — possible CSRF');
    if (new Date() > new Date(session.expiresAt)) throw new Error('OAuth session expired');

    // Security: Validate user binding if userId is provided
    if (userId && session.userId !== userId) throw new Error('User ID mismatch');

    const effectiveUserId = userId || session.userId;

    // Mark session as used
    await db.update(schema.oauthSessions)
      .set({ used: true })
      .where(eq(schema.oauthSessions.id, session.id));

    // Exchange code for tokens
    const tokenParams: Record<string, string> = {
      client_id: config.clientId(),
      client_secret: config.clientSecret(),
      redirect_uri: config.redirectUri(),
      code,
      ...config.extraTokenParams,
    };

    if (config.usePKCE) {
      tokenParams.code_verifier = session.codeVerifier;
    }

    let tokenUrl = config.tokenUrl;
    if (shopDomain && platform === 'shopify') {
      tokenUrl = tokenUrl.replace('{shop}', shopDomain);
    }
    if (shopDomain && platform === 'woocommerce') {
      tokenUrl = tokenUrl.replace('{domain}', shopDomain);
    }

    const response = await axios.post(tokenUrl, new URLSearchParams(tokenParams).toString(), {
      headers: {
        'Content-Type': config.tokenHeaders?.['Content-Type'] || 'application/x-www-form-urlencoded',
        ...config.tokenHeaders,
      },
    });

    const tokenData = response.data;

    // Fetch account profile for confirmation (Neural Handshake Verification)
    let accountHandle: string | undefined;
    let accountId: string | undefined = tokenData.shop_id || tokenData.sub?.toString();

    try {
      if (config.platform === 'tiktok') {
        const profileRes = await axios.get('https://open.tiktokapis.com/v2/user/info/?fields=username', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        accountHandle = `@${profileRes.data.data.user.username}`;
        accountId = profileRes.data.data.user.open_id;
      } else if (config.platform === 'google') {
        const profileRes = await axios.get('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        accountHandle = profileRes.data.items?.[0]?.snippet?.title;
        accountId = profileRes.data.items?.[0]?.id;
      } else if (config.platform === 'meta') {
        const profileRes = await axios.get('https://graph.facebook.com/v18.0/me?fields=name', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        accountHandle = profileRes.data.name;
        accountId = profileRes.data.id;
      } else if (config.platform === 'canva') {
        const profileRes = await axios.get('https://api.canva.com/v1/users/me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        accountHandle = profileRes.data.team_name || profileRes.data.name;
        accountId = profileRes.data.id;
      } else if (config.platform === 'etsy') {
        const profileRes = await axios.get('https://api.etsy.com/v3/application/shops', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'x-api-key': config.clientId()
          }
        });
        const shop = profileRes.data.results?.[0];
        accountHandle = shop?.shop_name;
        accountId = shop?.shop_id?.toString();
      } else if (config.platform === 'fiverr') {
        const profileRes = await axios.get('https://api.fiverr.com/v2/users/me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        accountHandle = profileRes.data.username;
        accountId = profileRes.data.id;
      }
    } catch (profileError) {
      console.warn(`[UniversalGateway] Failed to fetch profile for ${platform}:`, profileError);
    }

    // Save integration
    await integrationService.saveIntegration(effectiveUserId, platform, tokenData, accountId, accountHandle);

    // Save to Ownership Vault for high-trust security (AES-256)
    if (tokenData.refresh_token) {
      await vaultService.storeSecretWithEnvelope(effectiveUserId, platform, 'OAUTH_REFRESH', tokenData.refresh_token);
    }
    if (tokenData.access_token) {
      // For some platforms, the access token is the primary secret (e.g. Meta 60-day tokens)
      await vaultService.storeSecretWithEnvelope(effectiveUserId, platform, 'OAUTH_ACCESS', tokenData.access_token);
    }

    return { 
      status: 'success', 
      message: `${platform} integrated successfully`,
      handle: accountHandle
    };
  }
}

export const universalGatewayService = new UniversalGatewayService();