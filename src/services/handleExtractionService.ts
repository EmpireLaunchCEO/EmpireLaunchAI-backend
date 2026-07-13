import { chromium, Browser, Page } from 'playwright';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';

const { integrations } = schema;

/**
 * Platform-specific selectors for extracting @handles, shop names, or usernames
 * from each platform's dashboard/profile page after login.
 */
const HANDLE_SELECTORS: Record<string, { url: string; selector: string; transform?: (text: string) => string }> = {
  tiktok: {
    url: 'https://www.tiktok.com/@me',
    selector: '[data-e2e*="user-name"], [class*="share-title"], h1[data-e2e*="user"], [class*="ShareTitle"]',
    transform: (t: string) => t.startsWith('@') ? t : `@${t}`,
  },
  instagram: {
    url: 'https://www.instagram.com/accounts/edit/',
    selector: 'h2._aa_y, header h2',
    transform: (t: string) => t.startsWith('@') ? t : `@${t}`,
  },
  youtube: {
    url: 'https://www.youtube.com/account',
    selector: '#channel-handle, yt-formatted-string#channel-handle, .ytd-channel-name',
  },
  facebook: {
    url: 'https://www.facebook.com/me',
    selector: '[role="main"] h1, .x1heor9g',
  },
  pinterest: {
    url: 'https://www.pinterest.com/',
    selector: '[data-test-id="user-name"], .profileName, [data-test-id="username"]',
    transform: (t: string) => t.startsWith('@') ? t : `@${t}`,
  },
  etsy: {
    url: 'https://www.etsy.com/your/shops/me',
    selector: '.shop-name, .shop-name-and-nav-container h1, [data-shop-name]',
  },
  shopify: {
    url: 'https://admin.shopify.com/store/',
    selector: '.shop-name, .store-name, [class*="shop-name"]',
  },
  canva: {
    url: 'https://www.canva.com/myaccount',
    selector: '[class*="user-name"], [class*="profile-name"], .account-name',
  },
  godaddy: {
    url: 'https://account.godaddy.com/',
    selector: '[class*="user-name"], .account-info, [data-ouia-component-type="account-name"]',
  },
  systeme_io: {
    url: 'https://systeme.io/dashboard/profile',
    selector: '.user-name, .profile-name, [class*="user"]',
  },
  fiverr: {
    url: 'https://www.fiverr.com/dashboard',
    selector: '.user-name, .seller-name, [class*="username"]',
    transform: (t: string) => t.startsWith('@') ? t : `@${t}`,
  },
  behance: {
    url: 'https://www.behance.net/me',
    selector: '.Profile-name, .Project-owner-name, [class*="profile-name"]',
  },
  figma: {
    url: 'https://www.figma.com/files',
    selector: '[class*="profile_page--name"], [class*="top_nav--userName"]',
  },
  kittl: {
    url: 'https://www.kittl.com/dashboard',
    selector: '.user-name, .profile-name, [class*="user-name"]',
  },
  redbubble: {
    url: 'https://www.redbubble.com/account',
    selector: '.shop-name, .user-name, [class*="shop-name"]',
  },
  linkedin: {
    url: 'https://www.linkedin.com/feed/',
    selector: '.profile-rail-card__actor-link .profile-rail-card__name, [data-control-name="profile_railcard"]',
  },
  twitch: {
    url: 'https://www.twitch.tv/settings/profile',
    selector: 'input[aria-label="Username"][readonly], .tw-profile-setting__display-name',
  },
  amazon: {
    url: 'https://www.amazon.com/gp/css/homepage.html',
    selector: '#nav-link-accountList-nav-line-1, .ya-card__content--title',
  },
  ebay: {
    url: 'https://www.ebay.com/mys/home',
    selector: '[class*="user-id"], .gh-eb-li-a .gh-eb-ac-greeting',
  },
  squarespace: {
    url: 'https://account.squarespace.com/',
    selector: '[class*="account-name"], [class*="username"]',
  },
  wix: {
    url: 'https://www.wix.com/my-account/sites',
    selector: '[class*="account-name"], [class*="user-name"]',
  },
  gumroad: {
    url: 'https://gumroad.com/library',
    selector: '[class*="username"], [class*="user-name"]',
  },
  patreon: {
    url: 'https://www.patreon.com/home',
    selector: '[class*="username"], [class*="user-name"]',
  },
  tiktok_shop: {
    url: 'https://shop.tiktok.com/',
    selector: '[class*="shop-name"], [class*="store-name"]',
  },
  woocommerce: {
    url: 'https://wordpress.com/me',
    selector: '[class*="display-name"], .profile-gravatar__name',
  },
  shipstation: {
    url: 'https://ss.shipstation.com/account',
    selector: '[class*="user-name"], [class*="account-name"]',
  },
  gmail: {
    url: 'https://myaccount.google.com/',
    selector: '[data-user-name], [aria-label*="Account:"]',
  },
  stripe: {
    url: 'https://dashboard.stripe.com/',
    selector: '[class*="account-name"], [data-test="account-name"]',
  },
};

export class HandleExtractionService {
  /**
   * Extract handle for a specific platform by logging in via Playwright.
   * Reuses stored browser session cookies if available.
   */
  async extractHandle(
    userId: string,
    platform: string,
    page: Page | null = null
  ): Promise<string | null> {
    const platformConfig = HANDLE_SELECTORS[platform];
    if (!platformConfig) {
      console.log(`[HandleExtraction] No selector configured for ${platform}`);
      return null;
    }

    // If a page is already provided (from an active onboarding session), use it
    if (page) {
      return this.extractFromPage(page, platformConfig);
    }

    // Otherwise, launch a fresh browser session using saved cookies
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const context = await browser.newContext();
      const freshPage = await context.newPage();

      // Try to navigate to the platform's handle page
      try {
        await freshPage.goto(platformConfig.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // If we get the login page, try to load saved cookies
        const bodyText = await freshPage.textContent('body').catch(() => '');
        if (bodyText && (bodyText.includes('Log in') || bodyText.includes('Sign in'))) {
          console.log(`[HandleExtraction] ${platform} requires login — no active session available`);
          await context.close();
          return null;
        }

        return await this.extractFromPage(freshPage, platformConfig);
      } catch (err) {
        console.log(`[HandleExtraction] Failed to navigate to ${platform} handle page:`, (err as Error).message);
        return null;
      } finally {
        await context.close();
      }
    } catch (err) {
      console.error(`[HandleExtraction] Browser launch failed for ${platform}:`, (err as Error).message);
      return null;
    } finally {
      if (browser) await browser.close();
    }
  }

  /**
   * Extract handle text from the current page using the platform's configured selector.
   */
  private async extractFromPage(page: Page, config: { url: string; selector: string; transform?: (text: string) => string }): Promise<string | null> {
    try {
      await page.waitForSelector(config.selector, { timeout: 8000 });
      const text = await page.textContent(config.selector);
      if (text) {
        const cleaned = text.trim().split('\n')[0].trim();
        if (config.transform) {
          return config.transform(cleaned);
        }
        return cleaned;
      }
    } catch {
      // Fallback: try extracting the handle from the URL itself
      // TikTok profile URL: https://www.tiktok.com/@username
      // Other platforms often have similar patterns
      try {
        const url = page.url();
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        // Look for @username in the path
        for (const part of pathParts) {
          if (part.startsWith('@')) {
            const handle = part.substring(1); // Remove @
            if (handle && handle.length > 0) {
              console.log(`[HandleExtraction] Extracted handle from URL: @${handle}`);
              return `@${handle}`;
            }
          }
        }
        // Also try the last path segment as a fallback (many platforms use /username)
        if (pathParts.length > 0) {
          const lastSegment = pathParts[pathParts.length - 1];
          if (lastSegment && lastSegment.length > 0 && !lastSegment.includes('.') && !lastSegment.includes('?')) {
            console.log(`[HandleExtraction] Using last path segment as handle: ${lastSegment}`);
            return `@${lastSegment}`;
          }
        }
        console.log(`[HandleExtraction] Selector not found, URL: ${url}`);
      } catch {}
    }
    return null;
  }

  /**
   * Get all existing handles from the integrations table for a user.
   */
  async getStoredHandles(userId: string): Promise<Record<string, { handle: string | null; accountId: string | null }>> {
    try {
      const userIntegrations = await db.select()
        .from(integrations)
        .where(and(
          eq(integrations.userId, userId),
          eq(integrations.isActive, true)
        ));

      const result: Record<string, { handle: string | null; accountId: string | null }> = {};
      for (const integration of userIntegrations) {
        result[integration.platform] = {
          handle: integration.platformAccountHandle,
          accountId: integration.platformAccountId,
        };
      }
      return result;
    } catch (err) {
      console.error(`[HandleExtraction] Failed to get stored handles for user ${userId}:`, (err as Error).message);
      return {};
    }
  }

  /**
   * Update a stored handle for a platform integration.
   */
  async updateStoredHandle(userId: string, platform: string, handle: string, accountId?: string): Promise<void> {
    try {
      await db.update(integrations)
        .set({
          platformAccountHandle: handle,
          platformAccountId: accountId || undefined,
          updatedAt: new Date(),
        })
        .where(and(
          eq(integrations.userId, userId),
          eq(integrations.platform, platform),
          eq(integrations.isActive, true),
        ));
      console.log(`[HandleExtraction] Updated handle for ${platform}: ${handle}`);
    } catch (err) {
      console.error(`[HandleExtraction] Failed to update handle for ${platform}:`, (err as Error).message);
    }
  }
}

export const handleExtractionService = new HandleExtractionService();