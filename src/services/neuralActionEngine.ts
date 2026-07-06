import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { vaultService } from './vaultService.js';
import { chromium, Browser, Page, BrowserContext } from 'playwright';

/**
 * Neural Action Engine
 * 
 * Persists Playwright browser sessions after login and enables the AI
 * to perform actions on linked platforms (post videos, create listings, etc.)
 * using saved session cookies — no API keys needed.
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

  /**
   * Persist the current browser session (cookies + localStorage) to the vault.
   * Called after successful login in executeGenericBrowserLogin().
   */
  async persistSession(userId: string, platform: string, page: Page): Promise<void> {
    try {
      const cookies = await page.context().cookies();
      const localStorageData = await page.evaluate(() => {
        try {
          return JSON.stringify(window.localStorage);
        } catch {
          return '{}';
        }
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
   * Returns null if no session exists or it can't be loaded.
   */
  async loadSession(userId: string, platform: string): Promise<{ context: BrowserContext; page: Page } | null> {
    try {
      const sessionJson = await vaultService.getSecret(userId, platform, 'NEURAL_SESSION');
      if (!sessionJson) {
        console.log(`[NeuralActionEngine] No saved session for ${platform} user ${userId}`);
        return null;
      }

      const sessionData = JSON.parse(sessionJson);
      const browser = await this.getBrowser();
      const context = await browser.newContext();

      // Restore cookies
      if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
        await context.addCookies(sessionData.cookies);
      }

      const page = await context.newPage();

      // Restore localStorage on the session's domain
      if (sessionData.localStorage && sessionData.localStorage !== '{}') {
        try {
          const lsData = JSON.parse(sessionData.localStorage);
          // Need to navigate to the domain first before setting localStorage
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
   * Verify the session is still valid by checking if the page loads
   * without redirecting to a login page.
   */
  async verifySession(page: Page): Promise<boolean> {
    try {
      const currentUrl = page.url();
      const bodyText = (await page.textContent('body').catch(() => '')) || '';
      const loginIndicators = ['log in', 'sign in', 'login', 'signin', 'password', 'email address'];
      
      const isLoginPage = loginIndicators.some(indicator =>
        bodyText.toLowerCase().includes(indicator)
      );

      if (isLoginPage && currentUrl.includes('login')) {
        console.log(`[NeuralActionEngine] Session expired — redirected to login page`);
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Post a video to TikTok using the saved session.
   * 
   * @param userId - The user's ID
   * @param videoPath - Absolute path to the video file on the server
   * @param caption - Video caption text
   * @param hashtags - Array of hashtags (without #)
   * @returns true if posting succeeded, false otherwise
   */
  async postToTikTok(userId: string, videoPath: string, caption: string, hashtags: string[]): Promise<boolean> {
    console.log(`[NeuralActionEngine] Posting to TikTok for user ${userId}`);
    const session = await this.loadSession(userId, 'tiktok');
    if (!session) {
      console.error(`[NeuralActionEngine] No TikTok session found for user ${userId}`);
      return false;
    }

    const { context, page } = session;

    try {
      // Verify session is still valid
      const isValid = await this.verifySession(page);
      if (!isValid) {
        await context.close();
        return false;
      }

      // Navigate to TikTok upload page
      console.log(`[NeuralActionEngine] Navigating to TikTok upload...`);
      await page.goto('https://www.tiktok.com/upload', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await new Promise(r => setTimeout(r, 3000)); // Wait for React SPA

      // Check if we're on the upload page
      const currentUrl = page.url();
      if (!currentUrl.includes('upload')) {
        console.error(`[NeuralActionEngine] TikTok upload page not reached — redirected to ${currentUrl}`);
        await context.close();
        return false;
      }

      // Upload video — TikTok uses a file input
      const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000 }).catch(() => null);
      if (!fileInput) {
        console.error(`[NeuralActionEngine] TikTok: file input not found`);
        await context.close();
        return false;
      }

      await fileInput.setInputFiles(videoPath);
      console.log(`[NeuralActionEngine] TikTok: video file selected`);
      
      // Wait for upload to complete
      await new Promise(r => setTimeout(r, 5000));

      // Fill caption
      const captionInput = await page.waitForSelector(
        '[class*="caption"], [class*="description"], [contenteditable="true"]',
        { timeout: 10000 }
      ).catch(() => null);

      if (captionInput) {
        const fullText = hashtags.length > 0
          ? `${caption}\n\n${hashtags.map(h => `#${h}`).join(' ')}`
          : caption;
        await captionInput.click();
        await page.fill('[contenteditable="true"], [class*="caption"], [class*="description"]', fullText);
        console.log(`[NeuralActionEngine] TikTok: caption filled`);
      }

      // Click post button
      const postBtn = await page.waitForSelector(
        'button:has-text("Post"), [class*="post-btn"], button:has-text("Upload")',
        { timeout: 10000 }
      ).catch(() => null);

      if (postBtn) {
        await postBtn.click();
        console.log(`[NeuralActionEngine] TikTok: post button clicked`);
        await new Promise(r => setTimeout(r, 5000)); // Wait for post confirmation
      }

      await context.close();
      console.log(`[NeuralActionEngine] TikTok: post completed successfully`);
      return true;
    } catch (err: any) {
      console.error(`[NeuralActionEngine] TikTok post failed:`, err.message);
      await context.close().catch(() => {});
      return false;
    }
  }

  /**
   * Get the domain for a platform (used for localStorage restoration).
   */
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