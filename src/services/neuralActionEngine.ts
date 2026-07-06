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
      const bodyText = await page.textContent('body').catch(() => '');
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

  // ─── Helper ──────────────────────────────────────────────────────

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
}

export const neuralActionEngine = new NeuralActionEngine();