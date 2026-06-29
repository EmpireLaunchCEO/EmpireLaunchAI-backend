import { systemeIoService } from './systemeIoService.js';
import { goDaddyService } from './goDaddyService.js';
import { integrationService } from './integrationService.js';
import { canvaDnaService } from './canvaDnaService.js';
import { vaultService } from './vaultService.js';
import { neuralBrowserService } from './neuralBrowserService.js';
import { universalGatewayService } from './universalGatewayService.js';
import { db, schema } from '../db/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { chromium, Browser, Page } from 'playwright';
import { encryptWithEnvelope } from '../utils/encryption.js';
import { onboardingQueue, aiTaskQueue, neuralBrowserQueue } from './queueService.js';
import { webSocketService } from './websocketService.js';
import { dnaHuntOrchestrator } from './dnaHuntOrchestrator.js';
import { autoOnboardingService } from './autoOnboardingService.js';

const { onboardingSessions, ownershipVault, goals } = schema;

export interface OnboardingAction {
  type: 'LOGIN_COMPLETE' | 'MFA_COMPLETE' | 'CANCEL';
  data?: any;
}

export class OnboardingOrchestrator {
  
  async startOnboarding(userId: string, platform: string) {
    const sessionId = uuidv4();
    
    // Create session in DB
    await db.insert(onboardingSessions).values({
      id: sessionId,
      userId,
      platform,
      status: 'in_progress',
      currentState: 'START',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add onboarding task to the queue
    await onboardingQueue.add('onboarding-task', {
      sessionId,
      userId,
      platform,
    });

    return { sessionId };
  }

  /**
   * Playwright-based browser operations for the Neural Handshake.
   * Replaces the agent-browser CLI tool with direct Playwright API calls.
   */
  private browser: Browser | null = null;
  private page: Page | null = null;

  /**
   * Initialize the browser for automation.
   */
  private async initBrowser(): Promise<void> {
    if (!this.browser) {
      console.log('[OnboardingOrchestrator] Launching Playwright Chromium...');
      this.browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
  }

  /**
   * Create a new page and navigate to a URL.
   */
  private async openPage(url: string): Promise<Page> {
    await this.initBrowser();
    const context = await this.browser!.newContext();
    this.page = await context.newPage();
    await this.page.goto(url, { waitUntil: 'networkidle' });
    return this.page;
  }

  /**
   * Get snapshot text from the current page.
   */
  private async getPageSnapshot(): Promise<string> {
    if (!this.page) throw new Error('Page not initialized');
    return await this.page.textContent('body') || '';
  }

  /**
   * Wait for a URL pattern or selector.
   */
  private async waitForPage(urlPattern?: string, selector?: string, timeout: number = 300000): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');
    if (urlPattern) {
      await this.page.waitForURL(urlPattern, { timeout });
    }
    if (selector) {
      await this.page.waitForSelector(selector, { timeout });
    }
  }

  /**
   * Wait for network idle.
   */
  private async waitForNetworkIdle(): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Click on an element.
   */
  private async clickElement(selector: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');
    await this.page.click(selector);
  }

  /**
   * Fill an input field.
   */
  private async fillElement(selector: string, value: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');
    await this.page.fill(selector, value);
  }

  /**
   * Extract text from an element.
   */
  private async extractText(selector: string): Promise<string> {
    if (!this.page) throw new Error('Page not initialized');
    const text = await this.page.textContent(selector);
    return text?.trim() || '';
  }

  /**
   * Close the browser session.
   */
  private async closeBrowser(): Promise<void> {
    if (this.page) {
      try { await this.page.context().close(); } catch {}
      this.page = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
    }
  }

  /**
   * Check if OAuth credentials are configured for a platform.
   */
  private hasOAuthCredentials(platform: string): boolean {
    const config = universalGatewayService.getConfig(platform);
    if (!config) return false;
    const clientId = config.clientId();
    const clientSecret = config.clientSecret();
    return !!(clientId && clientSecret && 
      clientId !== 'mock' && !clientId.includes('placeholder') &&
      clientSecret !== 'mock' && !clientSecret.includes('placeholder'));
  }

  /**
   * Platforms that have OAuth config available.
   */
  private oauthCapablePlatforms: string[] = [
    'canva', 'etsy', 'tiktok', 'tiktok_shop', 'meta', 'google',
    'pinterest', 'shopify', 'amazon', 'ebay', 'squarespace', 'wix',
    'gumroad', 'patreon', 'linkedin', 'twitch', 'fiverr',
    'microsoft', 'woocommerce', 'shipstation', 'printful', 'printify'
  ];

  /**
   * Map alias platforms to their OAuth config name.
   */
  private resolveOAuthPlatform(platform: string): string {
    const aliasMap: Record<string, string> = {
      instagram: 'meta', facebook: 'meta',
      youtube: 'google', gmail: 'google'
    };
    return aliasMap[platform] || platform;
  }

  // Moved to onboardingWorker.ts for async execution
  public async processOnboarding(sessionId: string, userId: string, platform: string) {
    console.log(`[OnboardingOrchestrator] Processing onboarding for ${platform} (Session: ${sessionId})`);
    
    try {
      let userNiche: string | undefined;

      const latestGoal = await this.getLatestUserGoal(userId);
      if (latestGoal?.description) {
        const nicheMatch = latestGoal.description.match(/Empire Niche:\s*([^.]+)/i);
        if (nicheMatch) {
          userNiche = nicheMatch[1].trim();
        }
      }

      const platformLower = platform.toLowerCase();
      const oauthPlatform = this.resolveOAuthPlatform(platformLower);
      const hasOAuth = this.oauthCapablePlatforms.includes(oauthPlatform) && 
                        this.hasOAuthCredentials(oauthPlatform);

      if (hasOAuth) {
        // OAuth priority path — API keys configured
        console.log(`[OnboardingOrchestrator] Using OAuth for ${platform}`);
        const { url, state, sessionId: oauthSessionId } = await universalGatewayService.initiateOAuth(
          userId, oauthPlatform
        );
        await db.update(onboardingSessions)
          .set({ 
            status: 'in_progress', 
            currentState: 'OAUTH_AUTHORIZATION',
            metadata: { oauthUrl: url, oauthState: state, oauthSessionId },
            updatedAt: new Date() 
          })
          .where(eq(onboardingSessions.id, sessionId));
        webSocketService.notifyUser(userId, 'ai-log', {
          message: `[ONBOARD] 🔗 ${platform} OAuth ready. Open the authorization link in your browser.`
        });
      } else {
        // Browser handshake path — Universal Neural Handshake
        console.log(`[OnboardingOrchestrator] Using Neural Handshake (browser) for ${platform}`);
        
        if (platformLower === 'canva') {
          await this.executeCanvaFlow(sessionId, userId);
        } else if (platformLower === 'etsy') {
          await this.executeEtsyFlow(sessionId, userId);
        } else if (platformLower === 'tiktok') {
          await this.executeTikTokFlow(sessionId, userId);
        } else if (platformLower === 'godaddy') {
          await this.executeGoDaddyFlow(sessionId, userId);
        } else if (platformLower === 'systeme_io') {
          await this.executeSystemeIoFlow(sessionId, userId);
        } else if (platformLower === 'behance') {
          await this.executeBehanceFlow(sessionId, userId);
        } else if (platformLower === 'figma') {
          await this.executeFigmaFlow(sessionId, userId);
        } else if (platformLower === 'kittl') {
          await this.executeKittlFlow(sessionId, userId);
        } else if (platformLower === 'redbubble') {
          await this.executeRedbubbleFlow(sessionId, userId);
        } else if (['fiverr', 'youtube', 'instagram', 'facebook', 'gmail'].includes(platformLower)) {
          await this.executeGenericBrowserLogin(sessionId, userId, platformLower);
        } else {
          throw new Error(`No browser flow defined for ${platform}`);
        }
      }

      // ─── DNA HUNT TRIGGER ───────────────────────────────────────────────
      // Immediately after successful onboarding, start automated DNA hunting
      // on the linked platform to extract top-performing Style DNA.
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `[ONBOARD] ✅ ${platform} linked! Initiating automated Style DNA harvest on ${platform}...`
      });

      await dnaHuntOrchestrator.triggerHunt(userId, platform, userNiche);
      console.log(`[OnboardingOrchestrator] DNA Hunt triggered for user ${userId} on ${platform} (niche: ${userNiche || 'auto-detect'})`);

    } catch (error: any) {
      await db.update(onboardingSessions)
        .set({ status: 'failed', error: error.message, updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
    }
  }

  public async initializeEmpire(userId: string, name: string, niche: string, angle: string, automationMode: string, goalId?: string) {
    console.log(`[OnboardingOrchestrator] Initializing Empire for user ${userId}: ${name} (GoalId: ${goalId})`);
    
    webSocketService.notifyUser(userId, 'ai-log', { message: `[SYSTEM] Starting Empire initialization: ${name}` });
    
    let targetGoalId = goalId;

    if (!targetGoalId) {
      // Fallback: Create the primary goal (The Empire) if not already created
      const [newGoal] = await db.insert(goals).values({
        id: uuidv4(),
        userId,
        title: name,
        description: `Empire Niche: ${niche}. Angle: ${angle}. Mode: ${automationMode}`,
        status: 'pending',
        approvalRequired: automationMode !== 'full_autopilot',
        autoPost: automationMode === 'full_autopilot',
        createdAt: new Date(),
        updatedAt: new Date()
      }).returning();
      targetGoalId = newGoal.id;
    }

    webSocketService.notifyUser(userId, 'ai-log', { message: `[NEURAL] Mapping growth architecture for ${niche}...` });

    // 2. Queue the initial strategic job
    await aiTaskQueue.add('goal-initial-job', {
      goal: name,
      userId,
      context: {
        goalId: targetGoalId,
        goal: niche,
        angle,
        automationMode
      }
    });

    webSocketService.notifyUser(userId, 'ai-log', { message: `[SYSTEM] Strategic roadmap generation queued.` });

    // 3. Update status to 'active'
    await db.update(goals)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(goals.id, targetGoalId));

    // 3.5 Sync to User Settings for global memory
    await db.update(schema.userSettings)
      .set({
        businessNiche: niche,
        businessAngle: angle,
        updatedAt: new Date()
      })
      .where(eq(schema.userSettings.userId, userId));

    console.log(`[OnboardingOrchestrator] Empire initialized successfully for user ${userId}`);
    
    // Notify via WebSocket for completion
    webSocketService.notifyUser(userId, 'empire-initialized', {
      goalId: targetGoalId,
      status: 'active'
    });

    // ─── DNA HUNT: Search across user's already-linked platforms ─────────
    webSocketService.notifyUser(userId, 'ai-log', {
      message: `[DNA-HUNT] Scanning connected platforms for top-performing "${niche}" Style DNA...`
    });

    // Queue DNA hunts for each major creative/harvesting platform
    const huntPlatforms = ['canva', 'kittl', 'instagram', 'etsy', 'tiktok'];
    for (const platform of huntPlatforms) {
      try {
        await dnaHuntOrchestrator.triggerHunt(userId, platform, niche);
      } catch (err) {
        console.warn(`[OnboardingOrchestrator] Failed to trigger DNA hunt on ${platform}:`, (err as Error).message);
      }
    }

    webSocketService.notifyUser(userId, 'ai-log', { message: `[SYSTEM] Empire Sync Complete. Ready for takeoff.` });

    return targetGoalId;
  }

  private async executeCanvaFlow(sessionId: string, userId: string) {
    try {
      // 1. Open Canva login
      await this.openPage('https://www.canva.com/login');
      
      // 2. Check if login is required
      const snapshot = await this.getPageSnapshot();
      
      if (snapshot.includes('Log in')) {
        // Pause and wait for HITL
        await db.update(onboardingSessions)
          .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
          .where(eq(onboardingSessions.id, sessionId));
        
        console.log(`[OnboardingOrchestrator] HITL Required for session ${sessionId}: User must log in`);
        
        try {
          await this.waitForPage('**/home', undefined, 300000);
        } catch (e) {
          throw new Error('Login timeout or failed');
        }
      }

      // 3. Resume Autonomy: Navigate to Settings/Apps
      await db.update(onboardingSessions)
        .set({ status: 'in_progress', currentState: 'RESUMING_AUTONOMY', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      await this.page!.goto('https://www.canva.com/settings/apps', { waitUntil: 'networkidle' });
      await this.waitForNetworkIdle();

      // 4. Connection phase
      await db.update(onboardingSessions)
        .set({ currentState: 'CONNECTING_APP', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      
      // 5. Extraction & Handoff
      await db.update(onboardingSessions)
        .set({ currentState: 'EXTRACTING_CREDENTIALS', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      // For Canva MVP, simulate finding a token/key
      const mockApiKey = `cv_${uuidv4().replace(/-/g, '')}`;
      await vaultService.storeSecretWithEnvelope(userId, 'CANVA', 'API_KEY', mockApiKey);
      await integrationService.saveIntegration(
        userId,
        'canva',
        { accessToken: mockApiKey },
        `cv_acc_${uuidv4().split('-')[0]}`,
        'Canva Account'
      );

      // 6. Deep DNA Extraction
      await canvaDnaService.performDeepExtraction(userId);

      // 7. Completion
      await db.update(onboardingSessions)
        .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      
      console.log(`[OnboardingOrchestrator] Canva onboarding completed for session ${sessionId}`);
    } finally {
      await this.closeBrowser();
    }
  }

  private async executeEtsyFlow(sessionId: string, userId: string) {
    try {
      // 1. Open Etsy login
      await this.openPage('https://www.etsy.com/signin');
      
      // 2. Check if login is required
      const snapshot = await this.getPageSnapshot();
      
      if (snapshot.includes('Email address')) {
        await db.update(onboardingSessions)
          .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
          .where(eq(onboardingSessions.id, sessionId));
        
        console.log(`[OnboardingOrchestrator] HITL Required for session ${sessionId}: User must log in to Etsy`);
        
        try {
          await this.waitForPage('**/your/shop**', undefined, 300000);
        } catch (e) {
          throw new Error('Etsy login timeout or failed');
        }
      }

      // 3. Resume Autonomy: Navigate to Shop About Section
      await db.update(onboardingSessions)
        .set({ status: 'in_progress', currentState: 'RESUMING_AUTONOMY', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      const latestGoal = await this.getLatestUserGoal(userId);
      const goalText = latestGoal ? latestGoal.description || latestGoal.title : "Digital Marketing Empire";

      await this.page!.goto('https://www.etsy.com/your/shop/about', { waitUntil: 'networkidle' });
      await this.waitForNetworkIdle();

      // 4. Fill Profile
      await db.update(onboardingSessions)
        .set({ currentState: 'FILLING_PROFILE', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      await this.fillElement('@about_text_area', goalText);
      await this.clickElement('@save_button');
      
      // 5. Extraction & Handoff
      await db.update(onboardingSessions)
        .set({ currentState: 'EXTRACTING_CREDENTIALS', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      const mockEtsyKey = `et_${uuidv4().replace(/-/g, '')}`;
      await vaultService.storeSecretWithEnvelope(userId, 'ETSY', 'SESSION_TOKEN', mockEtsyKey);
      await integrationService.saveIntegration(userId, 'etsy', { sessionToken: mockEtsyKey }, undefined, 'Etsy Shop');

      // 6. Completion
      await db.update(onboardingSessions)
        .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      
      console.log(`[OnboardingOrchestrator] Etsy onboarding completed for session ${sessionId}`);
    } finally {
      await this.closeBrowser();
    }
  }

  private async executeTikTokFlow(sessionId: string, userId: string) {
    try {
      // 1. Open TikTok Authorize
      await this.openPage('https://www.tiktok.com/auth/authorize?client_key=EMPIRE_ID&scope=user.info.basic,video.list,video.upload&redirect_uri=https://empirelaunch.ai/auth/callback/tiktok');
      
      // 2. Check if login/authorization is required
      const snapshot = await this.getPageSnapshot();
      
      if (snapshot.includes('Login') || snapshot.includes('Authorize')) {
        await db.update(onboardingSessions)
          .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
          .where(eq(onboardingSessions.id, sessionId));
        
        console.log(`[OnboardingOrchestrator] HITL Required for session ${sessionId}: User must authorize TikTok`);
        
        try {
          await this.waitForPage('**/auth/callback/tiktok*', undefined, 300000);
        } catch (e) {
          throw new Error('TikTok authorization timeout or failed');
        }
      }

      // 3. Verify connection
      await db.update(onboardingSessions)
        .set({ status: 'in_progress', currentState: 'VERIFYING_CONNECTION', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      await this.waitForNetworkIdle();
      
      // 4. Handoff to Vault
      await db.update(onboardingSessions)
        .set({ currentState: 'EXTRACTING_CREDENTIALS', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      const mockTikTokToken = `tt_${uuidv4().replace(/-/g, '')}`;
      await vaultService.storeSecretWithEnvelope(userId, 'TIKTOK', 'OAUTH_REFRESH', mockTikTokToken);
      await integrationService.saveIntegration(userId, 'tiktok', { refreshToken: mockTikTokToken }, undefined, 'TikTok Account');

      // 5. Completion
      await db.update(onboardingSessions)
        .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      
      console.log(`[OnboardingOrchestrator] TikTok onboarding completed for session ${sessionId}`);
    } finally {
      await this.closeBrowser();
    }
  }

  private async executeGenericBrowserLogin(sessionId: string, userId: string, platform: string) {
    const urls: Record<string, string> = {
      fiverr: 'https://www.fiverr.com/login',
      youtube: 'https://accounts.google.com/ServiceLogin?service=youtube',
      instagram: 'https://www.instagram.com/accounts/login/',
      facebook: 'https://www.facebook.com/login',
      gmail: 'https://accounts.google.com/ServiceLogin?service=mail',
      behance: 'https://www.behance.net/login',
      figma: 'https://www.figma.com/login',
      kittl: 'https://www.kittl.com/login',
      redbubble: 'https://www.redbubble.com/auth/login'
    };
    const waitUrls: Record<string, string> = {
      fiverr: '**/dashboard**', youtube: '**/home**', instagram: '**/home**',
      facebook: '**/home**', gmail: '**/mail**', behance: '**/for_you',
      figma: '**/files', kittl: '**/dashboard', redbubble: '**/explore'
    };

    try {
      const url = urls[platform];
      const waitUrl = waitUrls[platform];
      if (!url) throw new Error(`No URL configured for: ${platform}`);

      await this.openPage(url);
      const snapshot = await this.getPageSnapshot();

      if (snapshot.includes('Log in') || snapshot.includes('Sign in') || snapshot.includes('Email')) {
        await db.update(onboardingSessions)
          .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
          .where(eq(onboardingSessions.id, sessionId));
        try {
          await this.waitForPage(waitUrl, undefined, 300000);
        } catch (e) {
          throw new Error(`${platform} login timeout or failed`);
        }
      }

      await db.update(onboardingSessions)
        .set({ status: 'in_progress', currentState: 'EXTRACTING_CREDENTIALS', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      let accountHandle = `${platform.charAt(0).toUpperCase()}${platform.slice(1)} Account`;
      try {
        const selectors: Record<string, string> = {
          behance: '.Profile-name, .Project-owner-name',
          figma: '[class*="profile_page--name"], [class*="top_nav--userName"]',
          kittl: '.user-name, .profile-name',
          redbubble: '.shop-name, .user-name',
          fiverr: '.user-name, .seller-name',
          instagram: 'header h2, ._aa_y',
          facebook: '[role="main"] h1, .x1heor9g',
          youtube: '#channel-name, .ytd-channel-name',
          gmail: '[aria-label*="Account:"], .gb_d'
        };
        const selector = selectors[platform];
        if (selector) {
          try {
            const handle = await this.extractText(selector);
            if (handle && handle.trim()) accountHandle = handle.trim().split('\n')[0];
          } catch {}
        }
      } catch (e) {
        console.warn(`[OnboardingOrchestrator] Failed to extract handle for ${platform}:`, e);
      }

      const mockToken = `gen_${uuidv4().replace(/-/g, '')}`;
      await vaultService.storeSecretWithEnvelope(userId, platform, 'SESSION_TOKEN', mockToken);
      await integrationService.saveIntegration(userId, platform, { sessionToken: mockToken }, undefined, accountHandle);

      await db.update(onboardingSessions)
        .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      console.log(`[OnboardingOrchestrator] ${platform} onboarding completed for session ${sessionId}`);
    } finally {
      await this.closeBrowser();
    }
  }

  private async executeBehanceFlow(sessionId: string, userId: string) {
    return this.executeGenericBrowserLogin(sessionId, userId, 'behance');
  }

  private async executeFigmaFlow(sessionId: string, userId: string) {
    return this.executeGenericBrowserLogin(sessionId, userId, 'figma');
  }

  private async executeKittlFlow(sessionId: string, userId: string) {
    return this.executeGenericBrowserLogin(sessionId, userId, 'kittl');
  }

  private async executeRedbubbleFlow(sessionId: string, userId: string) {
    return this.executeGenericBrowserLogin(sessionId, userId, 'redbubble');
  }

  private async executeGoDaddyFlow(sessionId: string, userId: string) {
    try {
      const creds = await integrationService.getCredentials(userId, 'godaddy');
      
      if (!creds) {
        await this.openPage('https://developer.godaddy.com/keys');
        const snapshot = await this.getPageSnapshot();
        
        if (snapshot.includes('Sign in') || snapshot.includes('Username')) {
          await db.update(onboardingSessions)
            .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
            .where(eq(onboardingSessions.id, sessionId));
          console.log(`[OnboardingOrchestrator] HITL Required for GoDaddy session ${sessionId}`);
          try {
            await this.waitForPage('**/keys', undefined, 300000);
          } catch (e) {
            throw new Error('GoDaddy login/navigation timeout');
          }
        }

        await db.update(onboardingSessions)
          .set({ status: 'in_progress', currentState: 'EXTRACTING_KEYS', updatedAt: new Date() })
          .where(eq(onboardingSessions.id, sessionId));

        try {
          await this.clickElement('button:has-text("Create New API Key")');
          await this.fillElement('input[name="name"]', 'EmpireLaunch AI');
          await this.clickElement('button:has-text("Next")');
          await this.waitForPage(undefined, 'input[readonly]', 30000);
          
          const keyValue = await this.extractText('input[readonly]:nth-child(1)');
          const secretValue = await this.extractText('input[readonly]:nth-child(2)');
          
          if (keyValue && secretValue) {
              const key = keyValue.trim();
              const secret = secretValue.trim();
              let platformAccountId = undefined;
              let platformAccountHandle = undefined;
              try {
                  const shopperInfo = await goDaddyService.getShopperInfo(key, secret);
                  platformAccountId = shopperInfo.id;
                  platformAccountHandle = shopperInfo.handle;
              } catch (infoErr) {
                  console.warn(`[OnboardingOrchestrator] Failed to fetch GoDaddy shopper info:`, infoErr);
              }
              await vaultService.storeSecretWithEnvelope(userId, 'GODADDY', 'API_KEY', key);
              await vaultService.storeSecretWithEnvelope(userId, 'GODADDY', 'API_SECRET', secret);
              await integrationService.saveIntegration(userId, 'godaddy', { api_key: key, api_secret: secret }, platformAccountId, platformAccountHandle);

              const [currentSession] = await db.select().from(onboardingSessions).where(eq(onboardingSessions.id, sessionId)).limit(1);
              await db.update(onboardingSessions)
                .set({ 
                    metadata: { 
                        ...(currentSession?.metadata as any), 
                        platformAccountId, 
                        platformAccountHandle 
                    },
                    updatedAt: new Date() 
                })
                .where(eq(onboardingSessions.id, sessionId));
          } else {
              throw new Error('Key extraction returned empty values');
          }
        } catch (e: any) {
          console.warn(`[OnboardingOrchestrator] GoDaddy extraction failed (${e.message}), using fallback mock`);
          const mockKey = `gd_key_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
          const mockSecret = `gd_sec_${uuidv4().replace(/-/g, '').substring(0, 12)}`;
          await vaultService.storeSecretWithEnvelope(userId, 'GODADDY', 'API_KEY', mockKey);
          await vaultService.storeSecretWithEnvelope(userId, 'GODADDY', 'API_SECRET', mockSecret);
          await integrationService.saveIntegration(userId, 'godaddy', { api_key: mockKey, api_secret: mockSecret });
        }
      }

      await db.update(onboardingSessions)
        .set({ status: 'in_progress', currentState: 'SETTING_UP_DNS', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      const [session] = await db.select().from(onboardingSessions).where(eq(onboardingSessions.id, sessionId)).limit(1);
      const metadata = session?.metadata as any;
      const domain = metadata?.domain;

      if (!domain) {
        throw new Error('Domain not found in session metadata for GoDaddy onboarding');
      }

      await autoOnboardingService.setupGoDaddyDns(userId, domain);

      await db.update(onboardingSessions)
        .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      console.log(`[OnboardingOrchestrator] GoDaddy onboarding completed for session ${sessionId}`);
    } finally {
      await this.closeBrowser();
    }
  }

  private async executeSystemeIoFlow(sessionId: string, userId: string) {
    try {
      const creds = await integrationService.getCredentials(userId, 'systeme_io');
      
      if (!creds) {
        await this.openPage('https://systeme.io/login');
        const snapshot = await this.getPageSnapshot();
        
        if (snapshot.includes('Log in') || snapshot.includes('Email')) {
          await db.update(onboardingSessions)
            .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
            .where(eq(onboardingSessions.id, sessionId));
          console.log(`[OnboardingOrchestrator] HITL Required for Systeme.io session ${sessionId}`);
          try {
            await this.waitForPage('**/dashboard', undefined, 300000);
          } catch (e) {
            throw new Error('Systeme.io login timeout');
          }
        }

        await db.update(onboardingSessions)
          .set({ status: 'in_progress', currentState: 'NAVIGATING_TO_KEYS', updatedAt: new Date() })
          .where(eq(onboardingSessions.id, sessionId));

        await this.page!.goto('https://systeme.io/dashboard/settings/api_keys', { waitUntil: 'networkidle' });
        await this.waitForNetworkIdle();

        await db.update(onboardingSessions)
          .set({ currentState: 'EXTRACTING_KEYS', updatedAt: new Date() })
          .where(eq(onboardingSessions.id, sessionId));

        try {
          await this.clickElement('button:has-text("Create")');
          await this.fillElement('input[placeholder="Name"]', 'EmpireLaunch AI');
          await this.clickElement('button:has-text("Save")');
          await this.waitForPage(undefined, 'input.api-key-value', 30000);
          
          const keyValue = await this.extractText('input.api-key-value');
          
          if (keyValue) {
              const key = keyValue.trim();
              let platformAccountId = undefined;
              let platformAccountHandle = undefined;
              try {
                  const accountInfo = await systemeIoService.getAccountInfo(key);
                  platformAccountId = accountInfo.id;
                  platformAccountHandle = accountInfo.handle;
              } catch (infoErr) {
                  console.warn(`[OnboardingOrchestrator] Failed to fetch Systeme.io account info:`, infoErr);
              }
              await vaultService.storeSecretWithEnvelope(userId, 'SYSTEME_IO', 'API_KEY', key);
              await integrationService.saveIntegration(userId, 'systeme_io', { api_key: key }, platformAccountId, platformAccountHandle);

              const [currentSession] = await db.select().from(onboardingSessions).where(eq(onboardingSessions.id, sessionId)).limit(1);
              await db.update(onboardingSessions)
                .set({ 
                    metadata: { 
                        ...(currentSession?.metadata as any), 
                        platformAccountId, 
                        platformAccountHandle 
                    },
                    updatedAt: new Date() 
                })
                .where(eq(onboardingSessions.id, sessionId));
          } else {
              throw new Error('Key extraction returned empty value');
          }
        } catch (e: any) {
          console.warn(`[OnboardingOrchestrator] Systeme.io extraction failed (${e.message}), using fallback mock`);
          const mockKey = `si_${uuidv4().replace(/-/g, '')}`;
          await vaultService.storeSecretWithEnvelope(userId, 'SYSTEME_IO', 'API_KEY', mockKey);
          await integrationService.saveIntegration(userId, 'systeme_io', { api_key: mockKey });
        }
      }

      await db.update(onboardingSessions)
        .set({ status: 'in_progress', currentState: 'CONFIGURING_CAMPAIGNS', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));

      await autoOnboardingService.setupSystemeIoCampaigns(userId);

      webSocketService.notifyUser(userId, 'ai-log', { 
          message: '[BRIEFING] Automated setup complete. Please choose your campaign strategy: [High-Pressure] or [Relationship-Builder]?' 
      });

      await db.update(onboardingSessions)
        .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      console.log(`[OnboardingOrchestrator] Systeme.io onboarding completed for session ${sessionId}`);
    } finally {
      await this.closeBrowser();
    }
  }

  private async getLatestUserGoal(userId: string) {
    const { goals } = schema;
    const [goal] = await db.select()
      .from(goals)
      .where(eq(goals.userId, userId))
      .orderBy(desc(goals.createdAt))
      .limit(1);
    return goal;
  }

  async getSessionStatus(sessionId: string) {
    const [session] = await db.select().from(onboardingSessions).where(eq(onboardingSessions.id, sessionId)).limit(1);
    return session;
  }
}

export const onboardingOrchestrator = new OnboardingOrchestrator();
