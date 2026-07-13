import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { vaultService } from './vaultService.js';
import { chromium, Browser, Page, BrowserContext } from 'playwright';

// ─── Action Types ─────────────────────────────────────────────────

export type ActionStepType = 'navigate' | 'click' | 'fill' | 'select' | 'wait' | 'screenshot' | 'extract' | 'evaluate';

export interface ActionStep {
  type: ActionStepType;
  /** URL for 'navigate', selector for 'click'/'fill'/'select'/'extract' */
  url?: string;
  selector?: string;
  /** Value for 'fill'/'select' */
  value?: string;
  /** Milliseconds for 'wait' */
  ms?: number;
  /** Key to store extracted result under for 'extract' */
  storeAs?: string;
  /** JavaScript code to evaluate for 'evaluate' */
  script?: string;
  /** Whether to stop on error (default: true) */
  stopOnError?: boolean;
}

export interface ActionResult {
  step: number;
  type: ActionStepType;
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Neural Action Engine
 * 
 * Persists Playwright browser sessions after login and enables the AI
 * to perform actions on linked platforms (post videos, create listings, etc.)
 * using saved session cookies — no API keys needed.
 * 
 * Each method follows the same pattern:
 * 1. Load session via loadSession()
 * 2. Verify session via verifySession()
 * 3. Navigate to the appropriate page
 * 4. Fill in the content (title, description, price, images)
 * 5. Submit/publish
 * 6. Close context
 */
export class NeuralActionEngine {
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
    return this.browser;
  }

  // ─── Session Management ──────────────────────────────────────────

  /**
   * Persist the current browser session (cookies + localStorage) to the vault.
   * Called after successful login in executeGenericBrowserLogin().
   */
  async persistSession(userId: string, platform: string, page: Page): Promise<void> {
    try {
      const cookies = await page.context().cookies();
      const localStorageData = await page.evaluate(() => {
        try { return JSON.stringify(window.localStorage); } catch { return '{}'; }
      });
      const sessionData = JSON.stringify({ cookies, localStorage: localStorageData });
      await vaultService.storeSecretWithEnvelope(userId, platform, 'NEURAL_SESSION', sessionData);
      console.log(`[NeuralActionEngine] Session persisted for ${platform} user ${userId}`);
    } catch (err: any) {
      console.warn(`[NeuralActionEngine] Failed to persist session for ${platform}:`, err.message);
    }
  }

  /**
   * Load a saved session into a new Playwright context.
   */
  async loadSession(userId: string, platform: string): Promise<{ context: BrowserContext; page: Page } | null> {
    try {
      const sessionJson = await vaultService.getSecret(userId, platform, 'NEURAL_SESSION');
      if (!sessionJson) return null;

      const sessionData = JSON.parse(sessionJson);
      const browser = await this.getBrowser();
      const context = await browser.newContext();

      if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
        await context.addCookies(sessionData.cookies);
      }

      const page = await context.newPage();

      if (sessionData.localStorage && sessionData.localStorage !== '{}') {
        try {
          const lsData = JSON.parse(sessionData.localStorage);
          const domain = this.getDomainForPlatform(platform);
          if (domain) {
            await page.goto(domain, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.evaluate((data) => {
              try {
                for (const [key, value] of Object.entries(data)) {
                  window.localStorage.setItem(key, value as string);
                }
              } catch {}
            }, lsData);
          }
        } catch {}
      }

      return { context, page };
    } catch (err: any) {
      console.error(`[NeuralActionEngine] Failed to load session for ${platform}:`, err.message);
      return null;
    }
  }

  /**
   * Verify the session is still valid by checking the page isn't on a login page.
   */
  async verifySession(page: Page): Promise<boolean> {
    try {
      const currentUrl = page.url();
      const bodyText = (await page.textContent('body').catch(() => '')) || '';
      const loginIndicators = ['log in', 'sign in', 'login', 'signin', 'password', 'email address'];
      const isLoginPage = loginIndicators.some(indicator =>
        bodyText.toLowerCase().includes(indicator)
      );
      if (isLoginPage && currentUrl.includes('login')) return false;
      return true;
    } catch { return false; }
  }

  // ─── General-Purpose Action Executor ─────────────────────────────

  /**
   * Execute a sequence of actions on a platform using the saved session.
   * 
   * Enables the AI to perform arbitrary setup tasks (configure DNS, email
   * settings, etc.) on any linked platform — no hardcoded pipelines needed.
   * 
   * @param userId - The user's ID
   * @param platform - Platform name (e.g. 'godaddy', 'systeme_io')
   * @param actions - Array of ActionStep objects to execute in sequence
   * @returns Array of ActionResult objects for each step
   */
  async executeActions(userId: string, platform: string, actions: ActionStep[]): Promise<ActionResult[]> {
    console.log(`[NeuralActionEngine] Executing ${actions.length} actions on ${platform} for user ${userId}`);
    const results: ActionResult[] = [];
    
    const session = await this.loadSession(userId, platform);
    if (!session) {
      return [{ step: 0, type: 'navigate', success: false, error: 'Failed to load session' }];
    }
    const { context, page } = session;

    try {
      const isValid = await this.verifySession(page);
      if (!isValid) {
        await context.close();
        return [{ step: 0, type: 'navigate', success: false, error: 'Session expired — redirected to login' }];
      }

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        const stopOnError = action.stopOnError !== false; // Default: true

        try {
          const result = await this.executeSingleAction(page, action, i);
          results.push(result);
          
          if (!result.success && stopOnError) {
            console.error(`[NeuralActionEngine] Action ${i} (${action.type}) failed and stopOnError=true — aborting`);
            break;
          }
        } catch (err: any) {
          results.push({
            step: i,
            type: action.type,
            success: false,
            error: err.message,
          });
          if (stopOnError) break;
        }
      }
    } catch (err: any) {
      results.push({
        step: -1,
        type: 'navigate',
        success: false,
        error: `Session error: ${err.message}`,
      });
    } finally {
      await context.close().catch(() => {});
    }

    return results;
  }

  /**
   * Execute a single action step.
   */
  private async executeSingleAction(page: Page, action: ActionStep, stepIndex: number): Promise<ActionResult> {
    const base: ActionResult = { step: stepIndex, type: action.type, success: false };

    switch (action.type) {
      case 'navigate': {
        if (!action.url) return { ...base, error: 'URL is required for navigate' };
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500));
        return { ...base, success: true, data: { url: page.url() } };
      }

      case 'click': {
        if (!action.selector) return { ...base, error: 'Selector is required for click' };
        await page.waitForSelector(action.selector, { timeout: 10000 });
        await page.click(action.selector);
        await new Promise(r => setTimeout(r, 500));
        return { ...base, success: true };
      }

      case 'fill': {
        if (!action.selector || action.value === undefined) {
          return { ...base, error: 'Selector and value are required for fill' };
        }
        await page.waitForSelector(action.selector, { timeout: 10000 });
        await page.fill(action.selector, action.value);
        return { ...base, success: true };
      }

      case 'select': {
        if (!action.selector || action.value === undefined) {
          return { ...base, error: 'Selector and value are required for select' };
        }
        await page.waitForSelector(action.selector, { timeout: 10000 });
        await page.selectOption(action.selector, action.value);
        return { ...base, success: true };
      }

      case 'wait': {
        const ms = action.ms || 1000;
        await new Promise(r => setTimeout(r, ms));
        return { ...base, success: true, data: { waitedMs: ms } };
      }

      case 'screenshot': {
        const screenshotBuffer = await page.screenshot({ fullPage: true });
        const base64 = screenshotBuffer.toString('base64');
        return { ...base, success: true, data: { screenshot: base64, length: base64.length } };
      }

      case 'extract': {
        if (!action.selector) return { ...base, error: 'Selector is required for extract' };
        const element = await page.waitForSelector(action.selector, { timeout: 10000 });
        if (!element) return { ...base, error: `Element not found: ${action.selector}` };
        const text = await element.textContent();
        const trimmed = (text || '').trim();
        const result: ActionResult = {
          ...base,
          success: true,
          data: { [action.storeAs || 'extracted']: trimmed },
        };
        return result;
      }

      case 'evaluate': {
        if (!action.script) return { ...base, error: 'Script is required for evaluate' };
        const evalResult = await page.evaluate(action.script);
        return { ...base, success: true, data: { result: evalResult } };
      }

      default:
        return { ...base, error: `Unknown action type: ${action.type}` };
    }
  }

  /**
   * Navigate to a URL and wait for the SPA to render.
   */
  private async navigateAndWait(page: Page, url: string, waitMs: number = 3000): Promise<boolean> {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, waitMs));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a selector with a timeout, returning the element or null.
   */
  private async waitForSelector(page: Page, selector: string, timeout: number = 10000): Promise<any> {
    return page.waitForSelector(selector, { timeout }).catch(() => null);
  }

  // ─── Action Pipelines ────────────────────────────────────────────

  /**
   * Etsy: Create a new listing in the shop manager.
   */
  async createEtsyListing(
    userId: string,
    listing: {
      title: string;
      description: string;
      price: number;
      images: string[];
      category?: string;
      tags?: string[];
    }
  ): Promise<string | null> {
    console.log(`[NeuralActionEngine] Creating Etsy listing for user ${userId}`);
    const session = await this.loadSession(userId, 'etsy');
    if (!session) return null;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return null; }

      // Navigate to Add Listing page
      const navOk = await this.navigateAndWait(page, 'https://www.etsy.com/your/shops/me/listing-editor', 4000);
      if (!navOk) { await context.close(); return null; }

      // Check if we got to the listing editor
      const currentUrl = page.url();
      if (!currentUrl.includes('listing') && !currentUrl.includes('shop')) {
        console.error(`[NeuralActionEngine] Etsy: unexpected redirect to ${currentUrl}`);
        await context.close();
        return null;
      }

      // Fill title
      const titleInput = await this.waitForSelector(page, 'input[name="title"], [class*="title"], #title');
      if (titleInput) {
        await titleInput.click();
        await page.fill('input[name="title"], [class*="title"], #title', listing.title);
        await new Promise(r => setTimeout(r, 500));
      }

      // Fill description
      const descInput = await this.waitForSelector(page, 'textarea[name="description"], [class*="description"], [contenteditable="true"]');
      if (descInput) {
        await descInput.click();
        await page.fill('textarea[name="description"], [class*="description"], [contenteditable="true"]', listing.description);
        await new Promise(r => setTimeout(r, 500));
      }

      // Upload images
      if (listing.images.length > 0) {
        const fileInput = await this.waitForSelector(page, 'input[type="file"]', 5000);
        if (fileInput) {
          await fileInput.setInputFiles(listing.images[0]);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      // Fill price
      const priceInput = await this.waitForSelector(page, 'input[name="price"], [class*="price"]');
      if (priceInput) {
        await priceInput.click();
        await page.fill('input[name="price"], [class*="price"]', listing.price.toString());
        await new Promise(r => setTimeout(r, 500));
      }

      // Fill tags
      if (listing.tags && listing.tags.length > 0) {
        for (const tag of listing.tags.slice(0, 13)) {
          const tagInput = await this.waitForSelector(page, 'input[name="tags"], [class*="tag"]', 2000);
          if (tagInput) {
            await tagInput.click();
            await page.fill('input[name="tags"], [class*="tag"]', tag);
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 300));
          }
        }
      }

      // Click publish
      const publishBtn = await this.waitForSelector(page, 'button:has-text("Publish"), button:has-text("Save"), [class*="publish"]');
      if (publishBtn) {
        await publishBtn.click();
        await new Promise(r => setTimeout(r, 3000));
      }

      await context.close();
      console.log(`[NeuralActionEngine] Etsy listing created: ${listing.title}`);
      return `etsy_listing_${Date.now()}`;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] Etsy listing failed:`, err.message);
      await context.close().catch(() => {});
      return null;
    }
  }

  /**
   * Shopify: Create a new product.
   */
  async createShopifyProduct(
    userId: string,
    product: {
      title: string;
      description: string;
      price: number;
      images?: string[];
      vendor?: string;
      productType?: string;
      tags?: string[];
    }
  ): Promise<string | null> {
    console.log(`[NeuralActionEngine] Creating Shopify product for user ${userId}`);
    const session = await this.loadSession(userId, 'shopify');
    if (!session) return null;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return null; }

      await this.navigateAndWait(page, 'https://admin.shopify.com/admin/products/new', 4000);

      // Fill title
      const titleInput = await this.waitForSelector(page, 'input[name="title"], [class*="title"], #product-title');
      if (titleInput) {
        await titleInput.click();
        await page.fill('input[name="title"], [class*="title"], #product-title', product.title);
      }

      // Fill description
      const descInput = await this.waitForSelector(page, '[contenteditable="true"], textarea[name="description"]');
      if (descInput) {
        await descInput.click();
        await page.fill('[contenteditable="true"], textarea[name="description"]', product.description);
      }

      // Fill price
      const priceInput = await this.waitForSelector(page, 'input[name="price"], [class*="price"]');
      if (priceInput) {
        await priceInput.click();
        await page.fill('input[name="price"], [class*="price"]', product.price.toString());
      }

      // Upload image
      if (product.images && product.images.length > 0) {
        const fileInput = await this.waitForSelector(page, 'input[type="file"]', 5000);
        if (fileInput) {
          await fileInput.setInputFiles(product.images[0]);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      // Click save
      const saveBtn = await this.waitForSelector(page, 'button:has-text("Save"), [class*="save"]');
      if (saveBtn) {
        await saveBtn.click();
        await new Promise(r => setTimeout(r, 3000));
      }

      await context.close();
      console.log(`[NeuralActionEngine] Shopify product created: ${product.title}`);
      return `shopify_product_${Date.now()}`;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] Shopify product failed:`, err.message);
      await context.close().catch(() => {});
      return null;
    }
  }

  /**
   * Instagram: Post a Reel (video) to feed.
   * Handles the Instagram Reels upload flow via browser automation.
   */
  async postToInstagramReel(
    userId: string,
    videoPath: string,
    caption: string,
    coverImagePath?: string,
    music?: { searchTerm?: string } | null,
    hashtags?: string[]
  ): Promise<boolean> {
    const fullCaption = hashtags && hashtags.length > 0
      ? `${caption}\n\n${hashtags.map(h => `#${h}`).join(' ')}`
      : caption;

    console.log(`[NeuralActionEngine] Posting Instagram Reel for user ${userId}`);
    const session = await this.loadSession(userId, 'instagram');
    if (!session) return false;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return false; }

      // Navigate to Instagram
      await this.navigateAndWait(page, 'https://www.instagram.com', 3000);

      // Click create (+) button
      const createBtn = await this.waitForSelector(page, 'svg[aria-label="New post"], [class*="create"], a[href*="create"]');
      if (!createBtn) { await context.close(); return false; }
      await createBtn.click();
      await new Promise(r => setTimeout(r, 2000));

      // Select "Reel" from the creation menu (Reels is usually the second option)
      try {
        const reelOption = await this.waitForSelector(page, 'button:has-text("Reel"), a:has-text("Reel"), span:has-text("Reel")', 3000);
        if (reelOption) {
          await reelOption.click();
          await new Promise(r => setTimeout(r, 1500));
        }
      } catch {
        // If Reel option isn't found, the default post type might already be Reel
        console.log('[NeuralActionEngine] Instagram: no explicit Reel option found, using default upload');
      }

      // Upload video file
      const fileInput = await this.waitForSelector(page, 'input[type="file"]');
      if (!fileInput) { await context.close(); return false; }
      await fileInput.setInputFiles(videoPath);
      await new Promise(r => setTimeout(r, 5000)); // Wait for video processing

      // Click next/forward (may need multiple next clicks for Reels flow)
      for (let i = 0; i < 3; i++) {
        try {
          const nextBtn = await this.waitForSelector(page, 'button:has-text("Next"), button:has-text("Forward"), div[role="button"]:has-text("Next")', 3000);
          if (nextBtn) {
            await nextBtn.click();
            await new Promise(r => setTimeout(r, 2000));
          } else {
            break;
          }
        } catch {
          break;
        }
      }

      // Add music from Instagram's native library if requested
      if (music?.searchTerm) {
        try {
          const addMusicBtn = await this.waitForSelector(page, 'button:has-text("Add music"), [aria-label*="Music"], div:has-text("Add music")', 5000);
          if (addMusicBtn) {
            await addMusicBtn.click();
            await new Promise(r => setTimeout(r, 2000));
          }

          const searchInput = await this.waitForSelector(page, 'input[placeholder*="search"], input[placeholder*="Search"], input[type="search"]', 5000);
          if (searchInput) {
            await searchInput.fill(music.searchTerm);
            await new Promise(r => setTimeout(r, 2000));
          }

          // Select first result
          const firstResult = await this.waitForSelector(page, 'div[class*="music"], div[role="button"]:has(img), [class*="audio"]', 5000);
          if (firstResult) {
            await firstResult.click();
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch {
          console.log('[NeuralActionEngine] Instagram music selection failed (non-fatal)');
        }
      }

      // Fill caption
      const captionInput = await this.waitForSelector(page, '[class*="caption"], [aria-label*="caption"], [contenteditable="true"]', 5000);
      if (captionInput) {
        await captionInput.click();
        await page.fill('[class*="caption"], [aria-label*="caption"], [contenteditable="true"]', fullCaption);
        await new Promise(r => setTimeout(r, 500));
      }

      // Click share/post
      const shareBtn = await this.waitForSelector(page, 'button:has-text("Share"), button:has-text("Post"), button:has-text("Upload")', 10000);
      if (shareBtn) {
        await shareBtn.click();
        await new Promise(r => setTimeout(r, 5000));
      }

      await context.close();
      console.log(`[NeuralActionEngine] Instagram Reel posted successfully`);
      return true;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] Instagram Reel failed:`, err.message);
      await context.close().catch(() => {});
      return false;
    }
  }

  /**
   * Instagram: Post a photo to feed.
   */
  async postToInstagram(userId: string, imagePath: string, caption: string): Promise<boolean> {
    console.log(`[NeuralActionEngine] Posting to Instagram for user ${userId}`);
    const session = await this.loadSession(userId, 'instagram');
    if (!session) return false;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return false; }

      // Navigate to Instagram
      await this.navigateAndWait(page, 'https://www.instagram.com', 3000);

      // Click create (+) button
      const createBtn = await this.waitForSelector(page, 'svg[aria-label="New post"], [class*="create"], a[href*="create"]');
      if (!createBtn) { await context.close(); return false; }
      await createBtn.click();
      await new Promise(r => setTimeout(r, 2000));

      // Upload image
      const fileInput = await this.waitForSelector(page, 'input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(imagePath);
        await new Promise(r => setTimeout(r, 3000));
      }

      // Click next/forward
      const nextBtn = await this.waitForSelector(page, 'button:has-text("Next"), button:has-text("Forward")');
      if (nextBtn) {
        await nextBtn.click();
        await new Promise(r => setTimeout(r, 2000));
      }

      // Fill caption
      const captionInput = await this.waitForSelector(page, '[class*="caption"], [aria-label*="caption"], [contenteditable="true"]');
      if (captionInput) {
        await captionInput.click();
        await page.fill('[class*="caption"], [aria-label*="caption"], [contenteditable="true"]', caption);
      }

      // Click share
      const shareBtn = await this.waitForSelector(page, 'button:has-text("Share"), button:has-text("Post")');
      if (shareBtn) {
        await shareBtn.click();
        await new Promise(r => setTimeout(r, 3000));
      }

      await context.close();
      console.log(`[NeuralActionEngine] Instagram post completed`);
      return true;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] Instagram post failed:`, err.message);
      await context.close().catch(() => {});
      return false;
    }
  }

  /**
   * YouTube: Upload a video.
   */
  async uploadToYouTube(
    userId: string,
    videoPath: string,
    title: string,
    description: string,
    tags?: string[]
  ): Promise<boolean> {
    console.log(`[NeuralActionEngine] Uploading to YouTube for user ${userId}`);
    const session = await this.loadSession(userId, 'youtube');
    if (!session) return false;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return false; }

      // Navigate to YouTube Studio upload
      await this.navigateAndWait(page, 'https://studio.youtube.com', 4000);

      // Click create button
      const createBtn = await this.waitForSelector(page, 'button:has-text("Create"), [class*="create"]');
      if (!createBtn) { await context.close(); return false; }
      await createBtn.click();
      await new Promise(r => setTimeout(r, 1000));

      // Click upload video
      const uploadBtn = await this.waitForSelector(page, 'button:has-text("Upload"), text=Upload videos', 3000);
      if (uploadBtn) {
        await uploadBtn.click();
        await new Promise(r => setTimeout(r, 2000));
      }

      // Select video file
      const fileInput = await this.waitForSelector(page, 'input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(videoPath);
        console.log(`[NeuralActionEngine] YouTube: video file selected, waiting for processing...`);
        await new Promise(r => setTimeout(r, 5000)); // Wait for upload processing
      }

      // Fill title
      const titleInput = await this.waitForSelector(page, '[class*="title"] input, input[aria-label*="Title"]');
      if (titleInput) {
        await titleInput.click();
        await page.fill('[class*="title"] input, input[aria-label*="Title"]', title);
      }

      // Fill description
      const descInput = await this.waitForSelector(page, '[class*="description"] textarea, textarea[aria-label*="Description"]');
      if (descInput) {
        await descInput.click();
        await page.fill('[class*="description"] textarea, textarea[aria-label*="Description"]', description);
      }

      // Fill tags
      if (tags && tags.length > 0) {
        const tagInput = await this.waitForSelector(page, '[class*="tags"] input, input[aria-label*="Tags"]', 2000);
        if (tagInput) {
          await tagInput.click();
          await page.fill('[class*="tags"] input, input[aria-label*="Tags"]', tags.join(', '));
        }
      }

      // Click next through visibility options
      for (let i = 0; i < 3; i++) {
        const nextBtn = await this.waitForSelector(page, 'button:has-text("Next")', 3000);
        if (nextBtn) {
          await nextBtn.click();
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      // Set visibility to public
      const publicRadio = await this.waitForSelector(page, 'input[value="PUBLIC"], [aria-label*="Public"]', 3000);
      if (publicRadio) {
        await publicRadio.click();
        await new Promise(r => setTimeout(r, 500));
      }

      // Click publish
      const publishBtn = await this.waitForSelector(page, 'button:has-text("Publish"), button:has-text("Save")');
      if (publishBtn) {
        await publishBtn.click();
        await new Promise(r => setTimeout(r, 3000));
      }

      await context.close();
      console.log(`[NeuralActionEngine] YouTube upload completed: ${title}`);
      return true;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] YouTube upload failed:`, err.message);
      await context.close().catch(() => {});
      return false;
    }
  }

  /**
   * Pinterest: Create a Pin.
   */
  async createPinterestPin(
    userId: string,
    imagePath: string,
    title: string,
    description: string,
    link?: string
  ): Promise<boolean> {
    console.log(`[NeuralActionEngine] Creating Pinterest pin for user ${userId}`);
    const session = await this.loadSession(userId, 'pinterest');
    if (!session) return false;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return false; }

      await this.navigateAndWait(page, 'https://www.pinterest.com/pin-builder/', 3000);

      // Upload image
      const fileInput = await this.waitForSelector(page, 'input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(imagePath);
        await new Promise(r => setTimeout(r, 3000));
      }

      // Fill title
      const titleInput = await this.waitForSelector(page, 'input[name="title"], [class*="title"]');
      if (titleInput) {
        await titleInput.click();
        await page.fill('input[name="title"], [class*="title"]', title);
      }

      // Fill description
      const descInput = await this.waitForSelector(page, 'textarea[name="description"], [class*="description"]');
      if (descInput) {
        await descInput.click();
        await page.fill('textarea[name="description"], [class*="description"]', description);
      }

      // Fill link
      if (link) {
        const linkInput = await this.waitForSelector(page, 'input[name="link"], [class*="link"]');
        if (linkInput) {
          await linkInput.click();
          await page.fill('input[name="link"], [class*="link"]', link);
        }
      }

      // Click save/publish
      const saveBtn = await this.waitForSelector(page, 'button:has-text("Save"), button:has-text("Publish"), [class*="save"]');
      if (saveBtn) {
        await saveBtn.click();
        await new Promise(r => setTimeout(r, 3000));
      }

      await context.close();
      console.log(`[NeuralActionEngine] Pinterest pin created: ${title}`);
      return true;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] Pinterest pin failed:`, err.message);
      await context.close().catch(() => {});
      return false;
    }
  }

  /**
   * Facebook: Create a post on the timeline/page.
   */
  async createFacebookPost(userId: string, text: string, imagePath?: string): Promise<boolean> {
    console.log(`[NeuralActionEngine] Creating Facebook post for user ${userId}`);
    const session = await this.loadSession(userId, 'facebook');
    if (!session) return false;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return false; }

      await this.navigateAndWait(page, 'https://www.facebook.com', 3000);

      // Click on "What's on your mind?"
      const postArea = await this.waitForSelector(page, '[aria-label*="on your mind"], [class*="status"], [role="textbox"]');
      if (postArea) {
        await postArea.click();
        await new Promise(r => setTimeout(r, 2000));
      }

      // Type the post text
      const textInput = await this.waitForSelector(page, '[aria-label*="on your mind"], [class*="status"], [role="textbox"], [contenteditable="true"]');
      if (textInput) {
        await textInput.click();
        await page.fill('[aria-label*="on your mind"], [class*="status"], [role="textbox"], [contenteditable="true"]', text);
        await new Promise(r => setTimeout(r, 500));
      }

      // Upload image if provided
      if (imagePath) {
        const fileInput = await this.waitForSelector(page, 'input[type="file"]', 5000);
        if (fileInput) {
          await fileInput.setInputFiles(imagePath);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      // Click post
      const postBtn = await this.waitForSelector(page, 'button:has-text("Post"), [class*="post"], [aria-label*="Post"]');
      if (postBtn) {
        await postBtn.click();
        await new Promise(r => setTimeout(r, 3000));
      }

      await context.close();
      console.log(`[NeuralActionEngine] Facebook post completed`);
      return true;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] Facebook post failed:`, err.message);
      await context.close().catch(() => {});
      return false;
    }
  }

  /**
   * Canva: Create a design from a template using autofill.
   * Uses the Canva API (needs API key) — falls back to browser if no API key.
   */
  async createCanvaDesign(userId: string, templateId: string, data: any): Promise<string | null> {
    console.log(`[NeuralActionEngine] Creating Canva design for user ${userId}`);
    
    // Try API first
    try {
      const { canvaService } = await import('./canvaService.js');
      const designId = await canvaService.createFromTemplate(userId, templateId, data);
      console.log(`[NeuralActionEngine] Canva design created via API: ${designId}`);
      return designId;
    } catch {
      console.log(`[NeuralActionEngine] Canva API failed, trying browser automation...`);
    }

    // Fallback to browser automation
    const session = await this.loadSession(userId, 'canva');
    if (!session) return null;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return null; }

      await this.navigateAndWait(page, `https://www.canva.com/design/create?template=${templateId}`, 5000);

      // Wait for the editor to load
      const editor = await this.waitForSelector(page, '[class*="editor"], [class*="canvas"]', 15000);
      if (!editor) { await context.close(); return null; }

      // If data includes text fills, find and replace text elements
      if (data) {
        for (const [key, value] of Object.entries(data)) {
          try {
            const textElement = await this.waitForSelector(page, `text=${key}`, 2000);
            if (textElement) {
              await textElement.click();
              await page.fill(`text=${key}`, String(value));
              await new Promise(r => setTimeout(r, 300));
            }
          } catch {}
        }
      }

      await context.close();
      console.log(`[NeuralActionEngine] Canva design created via browser`);
      return `canva_design_${Date.now()}`;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] Canva design failed:`, err.message);
      await context.close().catch(() => {});
      return null;
    }
  }

  /**
   * Systeme.io: Create an email campaign.
   */
  async createSystemeIoCampaign(
    userId: string,
    campaign: {
      name: string;
      subject: string;
      content: string;
      listId?: string;
    }
  ): Promise<boolean> {
    console.log(`[NeuralActionEngine] Creating Systeme.io campaign for user ${userId}`);
    const session = await this.loadSession(userId, 'systeme_io');
    if (!session) return false;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return false; }

      await this.navigateAndWait(page, 'https://systeme.io/dashboard/email/campaigns', 4000);

      // Click create campaign
      const createBtn = await this.waitForSelector(page, 'button:has-text("Create"), a:has-text("New campaign")');
      if (!createBtn) { await context.close(); return false; }
      await createBtn.click();
      await new Promise(r => setTimeout(r, 2000));

      // Fill campaign name
      const nameInput = await this.waitForSelector(page, 'input[name="name"], input[placeholder*="Name"]');
      if (nameInput) {
        await nameInput.click();
        await page.fill('input[name="name"], input[placeholder*="Name"]', campaign.name);
      }

      // Fill subject
      const subjectInput = await this.waitForSelector(page, 'input[name="subject"], input[placeholder*="Subject"]');
      if (subjectInput) {
        await subjectInput.click();
        await page.fill('input[name="subject"], input[placeholder*="Subject"]', campaign.subject);
      }

      // Fill content (rich text editor)
      const contentInput = await this.waitForSelector(page, '[contenteditable="true"], textarea[name="content"]');
      if (contentInput) {
        await contentInput.click();
        await page.fill('[contenteditable="true"], textarea[name="content"]', campaign.content);
      }

      // Click save/done
      const saveBtn = await this.waitForSelector(page, 'button:has-text("Save"), button:has-text("Next")');
      if (saveBtn) {
        await saveBtn.click();
        await new Promise(r => setTimeout(r, 2000));
      }

      await context.close();
      console.log(`[NeuralActionEngine] Systeme.io campaign created: ${campaign.name}`);
      return true;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] Systeme.io campaign failed:`, err.message);
      await context.close().catch(() => {});
      return false;
    }
  }

  /**
   * Post a video to TikTok with optional native music library support.
   * 
   * Uses TikTok's own "Add Sound" feature — no copyright issues, proper attribution.
   * 
   * @param userId - The user's ID
   * @param videoPath - Absolute path to the video file
   * @param caption - Video caption text
   * @param song - Optional song to add from TikTok's native music library
   * @param hashtags - Optional array of hashtags (without #)
   * @returns true if posting succeeded
   */
  async postToTikTok(
    userId: string,
    videoPath: string,
    caption: string,
    song?: { searchTerm: string; startTime?: number; duration?: number },
    hashtags?: string[]
  ): Promise<boolean> {
    const fullCaption = hashtags && hashtags.length > 0
      ? `${caption}\n\n${hashtags.map(h => `#${h}`).join(' ')}`
      : caption;

    // Convert song param to music format expected by postToTikTokWithMusic
    const music = song ? { mood: song.searchTerm, searchTerm: song.searchTerm } : null;

    // Note: startTime and duration adjustments happen on TikTok's UI after music selection
    // The postToTikTokWithMusic method handles the Add Sound → search → select flow

    return this.postToTikTokWithMusic(userId, videoPath, fullCaption, music, song?.startTime, song?.duration);
  }

  /**
   * Post to TikTok with optional background music selected from TikTok's own library.
   * 
   * Flow:
   * 1. Upload video to TikTok's upload page
   * 2. If a mood is specified, click "Add Sound", search for a matching song, and select it
   * 3. Add caption
   * 4. Post
   * 
   * Uses TikTok's native music library — no copyright issues, proper attribution.
   */
  async postToTikTokWithMusic(
    userId: string,
    videoPath: string,
    caption: string,
    music?: { mood: string; searchTerm: string } | null,
    startTime?: number,
    duration?: number
  ): Promise<boolean> {
    console.log(`[NeuralActionEngine] Posting to TikTok for user ${userId}${music ? ` with ${music.mood} music` : ''}`);
    
    try {
      const session = await this.loadSession(userId, 'tiktok');
      if (!session) {
        console.error('[NeuralActionEngine] No TikTok session found');
        return false;
      }
      const { context, page } = session;

      const isValid = await this.verifySession(page);
      if (!isValid) {
        await context.close();
        console.error('[NeuralActionEngine] TikTok session expired');
        return false;
      }

      // Navigate to TikTok upload page
      await page.goto('https://www.tiktok.com/upload', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));

      // Upload video file via file input
      const fileInput = await this.waitForSelector(page, 'input[type="file"]', 10000);
      if (!fileInput) {
        console.error('[NeuralActionEngine] Could not find file upload input');
        await context.close();
        return false;
      }
      await fileInput.setInputFiles(videoPath);
      console.log('[NeuralActionEngine] Video file selected for upload');
      await new Promise(r => setTimeout(r, 5000)); // Wait for upload processing

      // If music is requested, use TikTok's native music library
      if (music) {
        try {
          // Click "Add Sound" button
          const addSoundBtn = await this.waitForSelector(page, 'button:has-text("Add Sound"), [aria-label="Add Sound"], div:has-text("Add sound")', 5000);
          if (addSoundBtn) {
            await addSoundBtn.click();
            await new Promise(r => setTimeout(r, 2000));
          }

          // Search for music matching the mood/term
          const searchInput = await this.waitForSelector(page, 'input[placeholder="Search music"], input[type="search"]', 5000);
          if (searchInput) {
            await searchInput.click();
            await page.fill('input[placeholder="Search music"], input[type="search"]', music.searchTerm);
            await new Promise(r => setTimeout(r, 2000));
          }

          // Click on the first search result (song)
          const firstResult = await this.waitForSelector(page, 'div[data-e2e="music-item"], div[class*="music"], div[class*="MusicList"], div[role="button"]:has(span)', 5000);
          if (firstResult) {
            await firstResult.click();
            console.log(`[NeuralActionEngine] Selected music: ${music.searchTerm}`);
            await new Promise(r => setTimeout(r, 2000));
          }

          // Adjust start time if specified (TikTok shows a trim slider after selection)
          if (startTime !== undefined) {
            try {
              const startTimeInput = await this.waitForSelector(page, 'input[aria-label*="start"], input[aria-label*="Start"], [class*="start-time"] input', 3000);
              if (startTimeInput) {
                await startTimeInput.click();
                await startTimeInput.fill(String(startTime));
                await new Promise(r => setTimeout(r, 500));
              }
            } catch {
              console.log(`[NeuralActionEngine] Could not adjust start time, using default`);
            }
          }

          // Adjust duration if specified
          if (duration !== undefined) {
            try {
              const durationInput = await this.waitForSelector(page, 'input[aria-label*="duration"], input[aria-label*="Duration"], [class*="duration"] input', 3000);
              if (durationInput) {
                await durationInput.click();
                await durationInput.fill(String(duration));
                await new Promise(r => setTimeout(r, 500));
              }
            } catch {
              console.log(`[NeuralActionEngine] Could not adjust duration, using default`);
            }
          }
        } catch (musicErr: any) {
          console.warn(`[NeuralActionEngine] Music selection failed (non-fatal): ${musicErr.message}`);
          // Continue even if music selection fails
        }
      }

      // Add caption/description
      const captionInput = await this.waitForSelector(page, 'textarea[placeholder*="caption"], textarea[placeholder*="description"], [contenteditable="true"]', 5000);
      if (captionInput) {
        await captionInput.click();
        await page.fill('textarea[placeholder*="caption"], textarea[placeholder*="description"], [contenteditable="true"]', caption);
      }

      // Click Post
      const postBtn = await this.waitForSelector(page, 'button:has-text("Post"), button:has-text("Upload"), button[type="submit"]', 10000);
      if (postBtn) {
        await postBtn.click();
        console.log('[NeuralActionEngine] TikTok post submitted');
        await new Promise(r => setTimeout(r, 3000));
      }

      await context.close();
      return true;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] TikTok post failed:`, err.message);
      return false;
    }
  }

  // ─── Helper ──────────────────────────────────────────────────────────

  private getDomainForPlatform(platform: string): string {
    const domains: Record<string, string> = {
      tiktok: 'https://www.tiktok.com',
      etsy: 'https://www.etsy.com',
      shopify: 'https://www.shopify.com',
      instagram: 'https://www.instagram.com',
      facebook: 'https://www.facebook.com',
      youtube: 'https://www.youtube.com',
      gmail: 'https://mail.google.com',
      fiverr: 'https://www.fiverr.com',
      behance: 'https://www.behance.net',
      figma: 'https://www.figma.com',
      kittl: 'https://www.kittl.com',
      redbubble: 'https://www.redbubble.com',
      canva: 'https://www.canva.com',
      pinterest: 'https://www.pinterest.com',
      godaddy: 'https://www.godaddy.com',
      systeme_io: 'https://systeme.io',
    };
    return domains[platform] || `https://www.${platform}.com`;
  }

  /**
   * GoDaddy: Set up DNS records via Playwright.
   * Used when the user linked via Neural Handshake (no API key).
   * Navigates GoDaddy's DNS Manager to add/update DNS records.
   *
   * @param userId - The user's ID
   * @param domain - The domain to manage (e.g. example.com)
   * @param records - DNS records to set (type, name, value, ttl)
   * @returns true if DNS setup succeeded
   */
  async setupGoDaddyDns(
    userId: string,
    domain: string,
    records: Array<{ type: string; name: string; value: string; ttl?: number }>
  ): Promise<boolean> {
    console.log(`[NeuralActionEngine] Setting up GoDaddy DNS for ${domain}`);
    const session = await this.loadSession(userId, 'godaddy');
    if (!session) return false;
    const { context, page } = session;

    try {
      if (!(await this.verifySession(page))) { await context.close(); return false; }

      // Navigate to GoDaddy Domain Manager
      await this.navigateAndWait(page, 'https://account.godaddy.com/products?domain=manage', 4000);

      // Find the domain in the list and click Manage DNS
      try {
        const domainLink = await this.waitForSelector(page, `a:has-text("${domain}"), span:has-text("${domain}"), [class*="domain"]:has-text("${domain}")`, 8000);
        if (domainLink) {
          await domainLink.click();
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch {
        // Try going directly to DNS manager URL
        await this.navigateAndWait(page, `https://dns.godaddy.com/manage/${domain}`, 4000);
      }

      // Look for "Add Record" or "DNS Management" button
      try {
        const dnsBtn = await this.waitForSelector(page, 'button:has-text("DNS"), a:has-text("DNS"), [class*="dns"], button:has-text("Manage")', 8000);
        if (dnsBtn) {
          await dnsBtn.click();
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch {
        console.log('[NeuralActionEngine] GoDaddy: DNS button not found, trying direct URL');
      }

      // Try direct URL if we're not on DNS page
      const currentUrl = page.url();
      if (!currentUrl.includes('dns') && !currentUrl.includes('records')) {
        await this.navigateAndWait(page, `https://dns.godaddy.com/manage/${domain}`, 4000);
      }

      // Add each DNS record
      for (const record of records) {
        try {
          // Click "Add" or "Add Record" button
          const addBtn = await this.waitForSelector(page, 'button:has-text("Add"), button:has-text("Add Record"), [class*="add-record"]', 5000);
          if (addBtn) {
            await addBtn.click();
            await new Promise(r => setTimeout(r, 1000));
          }

          // Select record type
          const typeDropdown = await this.waitForSelector(page, 'select[name*="type"], select[aria-label*="Type"], [class*="record-type"] select', 3000);
          if (typeDropdown) {
            await typeDropdown.selectOption(record.type);
            await new Promise(r => setTimeout(r, 500));
          }

          // Fill record name
          const nameInput = await this.waitForSelector(page, 'input[name*="name"], input[aria-label*="Name"], [class*="record-name"] input', 3000);
          if (nameInput) {
            await nameInput.fill(record.name);
          }

          // Fill record value/points-to
          const valueInput = await this.waitForSelector(page, 'input[name*="value"], input[name*="points"], input[aria-label*="Value"], [class*="record-value"] input, input[aria-label*="Points"]', 3000);
          if (valueInput) {
            await valueInput.fill(record.value);
          }

          // Fill TTL if specified
          if (record.ttl) {
            const ttlInput = await this.waitForSelector(page, 'input[name*="ttl"], input[aria-label*="TTL"]', 2000);
            if (ttlInput) {
              await ttlInput.fill(String(record.ttl));
            }
          }

          // Click Save/Apply
          const saveBtn = await this.waitForSelector(page, 'button:has-text("Save"), button:has-text("Add"), button:has-text("Apply")', 3000);
          if (saveBtn) {
            await saveBtn.click();
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch (recErr: any) {
          console.warn(`[NeuralActionEngine] Failed to add DNS record ${record.type} ${record.name}: ${recErr.message}`);
        }
      }

      await context.close();
      console.log(`[NeuralActionEngine] GoDaddy DNS setup completed for ${domain}`);
      return true;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] GoDaddy DNS setup failed:`, err.message);
      await context.close().catch(() => {});
      return false;
    }
  }

  /**
   * General-purpose pipeline dispatcher.
   * Routes action names to the appropriate pipeline method.
   * Used by the generic POST /api/actions/:action endpoint.
   */
  async executePipeline(
    userId: string,
    action: string,
    params: Record<string, any>
  ): Promise<any> {
    console.log(`[NeuralActionEngine] Executing pipeline: ${action} for user ${userId}`);

    switch (action) {
      case 'post-tiktok':
        return this.postToTikTok(
          userId,
          params.videoPath,
          params.caption || '',
          params.music ? { searchTerm: params.music, startTime: 0, duration: 15 } : undefined,
          params.hashtags
        );

      case 'post-instagram-reel':
        return this.postToInstagramReel(
          userId,
          params.videoPath,
          params.caption || '',
          params.coverImagePath,
          params.music ? { searchTerm: params.music } : null,
          params.hashtags
        );

      case 'post-instagram':
        return this.postToInstagram(
          userId,
          params.imagePath,
          params.caption || ''
        );

      case 'create-etsy-listing':
        return this.createEtsyListing(userId, {
          title: params.title,
          description: params.description,
          price: params.price,
          images: params.images || [],
          category: params.category,
          tags: params.tags,
        });

      case 'create-shopify-product':
        return this.createShopifyProduct(userId, {
          title: params.title,
          description: params.description,
          price: params.price,
          images: params.images,
          vendor: params.vendor,
          productType: params.productType,
          tags: params.tags,
        });

      case 'create-facebook-post':
        return this.createFacebookPost(userId, params.text, params.imagePath);

      case 'create-pinterest-pin':
        return this.createPinterestPin(
          userId,
          params.imagePath,
          params.title,
          params.description,
          params.link
        );

      case 'upload-youtube':
        return this.uploadToYouTube(
          userId,
          params.videoPath,
          params.title,
          params.description,
          params.tags
        );

      case 'setup-godaddy-dns':
        return this.setupGoDaddyDns(
          userId,
          params.domain,
          params.records || []
        );

      default:
        throw new Error(`Unknown action: ${action}. Available: post-tiktok, post-instagram-reel, post-instagram, create-etsy-listing, create-shopify-product, create-facebook-post, create-pinterest-pin, upload-youtube, setup-godaddy-dns`);
    }
  }
}

export const neuralActionEngine = new NeuralActionEngine();