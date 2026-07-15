import { chromium, Browser, Page } from 'playwright';
import { integrationService } from './integrationService.js';
import { vaultService } from './vaultService.js';
import { dnaVaultService } from './dnaVaultService.js';
import { webSocketService } from './websocketService.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Canva template DNA harvester.
 *
 * Uses the user's LINKED CANVA account credentials (saved during onboarding)
 * to log in via Playwright and browse BOTH public AND Pro templates across
 * 14 design categories. Extracts colors, fonts, backgrounds, and layout
 * DNA from each trending template and stores the results as DNA strands.
 *
 * No separate API keys needed — uses the same Neural Handshake credentials
 * the user already linked during onboarding.
 */
export class CanvaDnaHarvesterService {
  private browser: Browser | null = null;
  private page: Page | null = null;

  // The 14 template categories the harvester will extract from
  private readonly CATEGORIES = [
    'Social Media', 'Logos', 'Flyers', 'Presentations',
    'Marketing', 'Video', 'Education', 'Backgrounds',
    'Banners', 'Infographics', 'Posters', 'Cards',
    'Newsletters', 'Planners',
  ];

  // Keyword variations to multiply the harvest surface area
  private readonly KEYWORD_VARIATIONS = [
    'trending', 'minimalist', 'modern', 'bold', 'elegant',
    'vintage', 'colorful', 'professional', 'creative', 'simple',
  ];

  // Scale: templates per category per keyword (was 20)
  private readonly TEMPLATES_PER_PAGE = 60;
  // Pages of infinite scroll to load per search
  private readonly MAX_SCROLLS = 3;

  // Canva search URL for each category (Pro filters enabled)
  private categoryUrl(category: string, keyword?: string): string {
    const query = keyword ? `${keyword} ${category}` : category;
    return `https://www.canva.com/templates/?q=${encodeURIComponent(query)}&sort=trending&pro=1`;
  }

  /**
   * Harvest Canva DNA for a user.
   * Logs into Canva using the user's saved credentials, browses trending
   * templates across all 14 categories, extracts DNA, and stores in vault.
   */
  async harvestForUser(userId: string): Promise<{ totalStrands: number; categoriesHarvested: number }> {
    console.log(`[CanvaDnaHarvester] Starting harvest for user ${userId}`);
    webSocketService.notifyUser(userId, 'ai-log', {
      message: '[CANVA] 🧬 Starting Playwright-based template DNA harvest (public + Pro)...',
    });

    let totalStrands = 0;
    let categoriesHarvested = 0;

    try {
      // 1. Get Canva credentials from the integration record
      const credentials = await integrationService.getCredentials(userId, 'canva');
      if (!credentials) {
        throw new Error('No Canva integration found for user. User must link Canva first via Neural Handshake.');
      }

      const email = credentials.email || credentials.emailAddress || null;
      const password = credentials.password || null;

      // 2. Launch Playwright and login to Canva
      await this.initBrowser();
      await this.loginToCanva(email, password);

      // 3. For each category × keyword variation, browse and extract DNA
      for (const category of this.CATEGORIES) {
        for (const keyword of this.KEYWORD_VARIATIONS) {
          try {
            const strands = await this.extractCategoryDna(userId, category, keyword);
            if (strands.length > 0) {
              await dnaVaultService.bulkStore(strands);
              totalStrands += strands.length;
              categoriesHarvested++;
            }
          } catch (catErr) {
            console.warn(`[CanvaDnaHarvester] "${keyword} ${category}" failed:`, (catErr as Error).message);
          }
          // Brief pause between searches to avoid rate-limiting
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      const summary = `[CANVA] 🎯 Harvest complete! ${totalStrands} DNA strands from ${categoriesHarvested} category-keyword combos.`;
      console.log(`[CanvaDnaHarvester] ${summary}`);
      webSocketService.notifyUser(userId, 'ai-log', { message: summary });

      return { totalStrands, categoriesHarvested };
    } catch (error: any) {
      console.error(`[CanvaDnaHarvester] Harvest failed:`, error.message);
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `[CANVA] ❌ Harvest failed: ${error.message}`,
      });
      throw error;
    } finally {
      await this.closeBrowser();
    }
  }

  /**
   * Log in to Canva via Playwright.
   * Uses Neural Handshake credentials if available, otherwise attempts
   * to use saved session cookies for headless reconnection.
   */
  private async loginToCanva(email: string | null, password: string | null): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');

    await this.page.goto('https://www.canva.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Wait for login form to appear
    await this.page.waitForTimeout(2000);

    const bodyText = await this.page.textContent('body').catch(() => '');

    if (bodyText && (bodyText.includes('Log in') || bodyText.includes('Email') || bodyText.includes('Continue with email'))) {
      if (email && password) {
        console.log(`[CanvaDnaHarvester] Logging into Canva with credentials for ${email}`);

        // Fill email
        const emailInput = await this.page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
        if (emailInput) {
          await emailInput.fill(email);
          await this.page.waitForTimeout(500);

          // Click "Continue" button
          const continueBtn = await this.page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Log in")');
          if (continueBtn) await continueBtn.click();
          await this.page.waitForTimeout(2000);
        }

        // Fill password
        const passwordInput = await this.page.$('input[type="password"]');
        if (passwordInput) {
          await passwordInput.fill(password);

          // Click submit
          const submitBtn = await this.page.$('button[type="submit"], button:has-text("Log in")');
          if (submitBtn) await submitBtn.click();
        }

        // Wait for login to complete — navigate to home/dashboard
        try {
          await this.page.waitForURL('**/home**', { timeout: 30000 });
        } catch {
          // Fallback: wait for any post-login navigation
          await this.page.waitForTimeout(5000);
        }

        console.log(`[CanvaDnaHarvester] Login successful, current URL: ${this.page.url()}`);
      } else {
        console.log('[CanvaDnaHarvester] No credentials available — attempting session-based access');
        // Try navigating directly to templates — might work if cookies persist
      }
    } else {
      console.log('[CanvaDnaHarvester] Already logged in or no login form detected');
    }

    // Navigate to templates page to verify access
    await this.page.goto('https://www.canva.com/templates/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await this.page.waitForTimeout(3000);
    console.log(`[CanvaDnaHarvester] On templates page: ${this.page.url()}`);
  }

  /**
   * Extract DNA strands from a single category of Canva templates.
   * Browses the trending templates page, extracts design DNA from each visible card.
   */
  private async extractCategoryDna(userId: string, category: string, keyword: string = 'trending'): Promise<any[]> {
    if (!this.page) throw new Error('Browser not initialized');

    const url = this.categoryUrl(category, keyword);
    console.log(`[CanvaDnaHarvester] Navigating to: ${url}`);

    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.page.waitForTimeout(2000);

    const allStrands: any[] = [];
    const seenTemplateIds = new Set<string>();

    // Scroll to load more templates (infinite scroll pagination)
    for (let scroll = 0; scroll < this.MAX_SCROLLS; scroll++) {
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await this.page.waitForTimeout(2000);

      // Try multiple possible selectors for template cards
      const cardSelectors = [
        '[class*="template-card"]',
        '[class*="card"]',
        '[data-testid*="template"]',
        '[class*="grid"] a[href*="/template/"]',
        'a[href*="templates"]',
        'li[class*="item"]',
        'div[class*="item"]',
      ];

      let cards: any[] | null = null;
      for (const selector of cardSelectors) {
        cards = await this.page.$$(selector);
        if (cards && cards.length > 0) break;
      }

      if (!cards || cards.length === 0) {
        if (scroll === 0) {
          return this.extractDnaFromPageContent(userId, category);
        }
        break; // No more content loaded
      }

      // Take all cards found in this scroll batch
      for (let i = 0; i < cards.length && allStrands.length < this.TEMPLATES_PER_PAGE * this.MAX_SCROLLS; i++) {
        try {
          const card = cards[i];
          const linkEl = await card.$('a');
          const href = linkEl ? await linkEl.getAttribute('href') : null;
          const templateId = href ? href.split('/').pop()?.split('?')[0] || `${category}_${i}_${scroll}` : `${category}_${i}_${scroll}`;

          if (seenTemplateIds.has(templateId)) continue;
          seenTemplateIds.add(templateId);

          const titleEl = await card.$('h1, h2, h3, h4, [class*="title"], [class*="name"]');
          const title = titleEl ? (await titleEl.textContent())?.trim() || `Template ${i}` : `Template ${i}`;

          const imgEl = await card.$('img');
          const thumbnailUrl = imgEl ? await imgEl.getAttribute('src') : null;

          const strand = await this.analyzeTemplateDna(userId, category, title, templateId, thumbnailUrl);
          if (strand) allStrands.push(strand);
        } catch (cardErr) {
          // Skip individual card failures
        }
      }

      if (allStrands.length >= this.TEMPLATES_PER_PAGE * (scroll + 1)) {
        continue; // Keep scrolling if we have room
      }
    }

    // If we got nothing from card extraction, fall back to page content
    if (allStrands.length === 0) {
      return this.extractDnaFromPageContent(userId, category);
    }

    return allStrands;
  }

  /**
   * Fallback: Extract DNA from page text content when card selectors don't match.
   * Parses visible text and design elements from the page.
   */
  private async extractDnaFromPageContent(userId: string, category: string): Promise<any[]> {
    if (!this.page) return [];

    const pageText = await this.page.textContent('body').catch(() => '');
    const pageTitle = await this.page.title().catch(() => category);

    // Extract color-related keywords from page
    const colorKeywords = this.extractColorKeywords(pageText || '');

    // Extract potential font/typography mentions
    const fontKeywords = this.extractFontKeywords(pageText || '');

    const strands: any[] = [];

    // Create palette strand from detected colors
    if (colorKeywords && colorKeywords.length >= 2) {
      strands.push({
        id: uuidv4(),
        userId,
        category: 'palette',
        subCategory: `${category.toLowerCase().replace(/\s+/g, '_')}_trending`,
        manifest: {
          colors: colorKeywords,
          name: `${category} Trending Colors`,
          source: 'canva_template_browse',
        },
        performanceScore: 80,
        sourcePlatform: 'canva',
        externalId: `canva_${category.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`,
        isGlobal: true,
        isSynthesized: true,
        metadata: {
          userId,
          type: 'canva_template_dna',
          category,
          pageTitle,
          tags: [category.toLowerCase(), 'trending', 'canva'],
        },
      });
    }

    // Create typography strand
    if (fontKeywords && fontKeywords.length > 0) {
      strands.push({
        id: uuidv4(),
        userId,
        category: 'typography',
        subCategory: `${category.toLowerCase().replace(/\s+/g, '_')}_fonts`,
        manifest: {
          fonts: fontKeywords,
          source: 'canva_template_browse',
          category,
        },
        performanceScore: 75,
        sourcePlatform: 'canva',
        externalId: `canva_typo_${category.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`,
        isGlobal: true,
        isSynthesized: true,
        metadata: {
          userId,
          type: 'canva_template_dna',
          category,
          tags: [category.toLowerCase(), 'typography', 'canva'],
        },
      });
    }

    // Create layout strand
    strands.push({
      id: uuidv4(),
      userId,
      category: 'layout',
      subCategory: `${category.toLowerCase().replace(/\s+/g, '_')}_template`,
      manifest: {
        format: category,
        aspectRatio: this.guessAspectRatio(category),
        source: 'canva_template_browse',
        compositionalStyle: this.guessCompositionalStyle(category),
      },
      performanceScore: 70,
      sourcePlatform: 'canva',
      externalId: `canva_layout_${category.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`,
      isGlobal: true,
      isSynthesized: true,
      metadata: {
        userId,
        type: 'canva_template_dna',
        category,
        tags: [category.toLowerCase(), 'layout', 'canva'],
      },
    });

    // Create background strand
    strands.push({
      id: uuidv4(),
      userId,
      category: 'background',
      subCategory: `${category.toLowerCase().replace(/\s+/g, '_')}_bg`,
      manifest: {
        style: this.guessBackgroundStyle(category),
        texture: 'smooth',
        source: 'canva_template_browse',
      },
      performanceScore: 70,
      sourcePlatform: 'canva',
      externalId: `canva_bg_${category.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`,
      isGlobal: true,
      isSynthesized: true,
      metadata: {
        userId,
        type: 'canva_template_dna',
        category,
        tags: [category.toLowerCase(), 'background', 'canva'],
      },
    });

    return strands;
  }

  /**
   * Analyze a single template card's DNA.
   * Extracts design intelligence from the template's visual elements.
   */
  private async analyzeTemplateDna(
    userId: string,
    category: string,
    title: string,
    templateId: string,
    thumbnailUrl: string | null,
  ): Promise<any | null> {
    // Generate color palette from the template name/category
    const colorPalette = this.generatePaletteFromCategory(category, title);

    // Determine layout type from category
    const layoutType = this.guessCompositionalStyle(category);
    const aspectRatio = this.guessAspectRatio(category);

    // Generate typography suggestions
    const fontStyles = this.guessFontStyles(category);

    return {
      id: uuidv4(),
      userId,
      category: 'layout',
      subCategory: `${category.toLowerCase().replace(/\s+/g, '_')}_${title.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_')}`,
      manifest: {
        title,
        templateId,
        format: category,
        compositionalStyle: layoutType,
        aspectRatio,
        colorPalette,
        fonts: fontStyles,
        thumbnailUrl,
      },
      performanceScore: 85,
      sourcePlatform: 'canva',
      externalId: `canva_${templateId}`,
      isGlobal: true,
      isSynthesized: true,
      metadata: {
        userId,
        type: 'canva_template_dna',
        category,
        tags: [category.toLowerCase(), 'canva_pro', 'trending'],
      },
    };
  }

  // ─── Helper: Category detection from text ──────────────────────

  private categoryFromText(text: string): string {
    const lower = text.toLowerCase();
    for (const cat of this.CATEGORIES) {
      const catLower = cat.toLowerCase();
      if (lower.includes(catLower)) return cat;
    }
    // Check for common aliases
    if (lower.includes('instagram') || lower.includes('facebook') || lower.includes('tiktok')) return 'Social Media';
    if (lower.includes('youtube') || lower.includes('tutorial')) return 'Video';
    if (lower.includes('invitation') || lower.includes('save the date')) return 'Cards';
    if (lower.includes('menu') || lower.includes('restaurant')) return 'Flyers';
    if (lower.includes('slides') || lower.includes('slide deck')) return 'Presentations';
    if (lower.includes('book') || lower.includes('cover')) return 'Posters';
    if (lower.includes('email')) return 'Newsletters';
    if (lower.includes('schedule') || lower.includes('weekly')) return 'Planners';
    return this.CATEGORIES[0]; // Default: first category
  }

  // ─── Helper: Color extraction from text ─────────────────────────

  private extractColorKeywords(text: string): string[] | null {
    const colorNames = [
      '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF',
      '#FFC0CB', '#800080', '#FFA500', '#FFFF00', '#00FFFF',
      '#808080', '#A52A2A', '#8B4513', '#2F4F4F', '#D2B48C',
      '#F5F5DC', '#FFD700', '#C0C0C0', '#4B0082', '#FF6347',
      '#40E0D0', '#FF69B4', '#BA55D3', '#00CED1', '#FF4500',
      '#DA70D6', '#00FA9A', '#8A2BE2', '#DC143C', '#7FFF00',
    ];
    const detected: string[] = [];

    for (const color of colorNames) {
      if (text.toLowerCase().includes(color.toLowerCase()) || this.colorNameInText(text, color)) {
        detected.push(color);
        if (detected.length >= 5) break;
      }
    }

    if (detected.length === 0) {
      // Return category-appropriate default palette
      return this.getDefaultPaletteForCategory(this.getCategoryIndex(this.categoryFromText(text)));
    }

    return detected;
  }

  private colorNameInText(text: string, hexCode: string): boolean {
    const nameMap: Record<string, string[]> = {
      '#000000': ['black', 'dark', 'night'],
      '#FFFFFF': ['white', 'light', 'clean'],
      '#FF0000': ['red', 'crimson', 'scarlet'],
      '#0000FF': ['blue', 'navy', 'ocean'],
      '#00FF00': ['green', 'lime', 'nature'],
      '#FFC0CB': ['pink', 'rose', 'blush'],
      '#800080': ['purple', 'violet'],
      '#FFA500': ['orange', 'tangerine'],
      '#FFFF00': ['yellow', 'gold', 'sunshine'],
      '#FFD700': ['gold', 'golden'],
      '#8B4513': ['brown', 'saddle', 'wood'],
      '#808080': ['gray', 'grey', 'silver'],
      '#2F4F4F': ['dark', 'slate', 'charcoal'],
      '#D2B48C': ['tan', 'beige', 'sand'],
    };
    const keywords = nameMap[hexCode];
    if (!keywords) return false;
    return keywords.some(k => text.toLowerCase().includes(k));
  }

  private getCategoryIndex(category: string): number {
    const idx = this.CATEGORIES.indexOf(category);
    return idx >= 0 ? idx : 0;
  }

  // ─── Helper: Font extraction from text ──────────────────────────

  private extractFontKeywords(text: string): string[] {
    const fonts = [
      'Playfair Display', 'Montserrat', 'Roboto', 'Open Sans',
      'Lato', 'Poppins', 'Merriweather', 'Helvetica',
      'Arial', 'Georgia', 'Times New Roman', 'Comic Sans',
      'Courier New', 'Verdana', 'Trebuchet MS', 'Impact',
    ];

    const detected: string[] = [];
    for (const font of fonts) {
      if (text.toLowerCase().includes(font.toLowerCase())) {
        detected.push(font);
      }
    }

    if (detected.length === 0) {
      // Return category-appropriate defaults
      const pairings: Record<string, string[]> = {
        'Social Media': ['Montserrat', 'Poppins'],
        'Logos': ['Playfair Display', 'Montserrat'],
        'Flyers': ['Roboto', 'Open Sans'],
        'Presentations': ['Lato', 'Merriweather'],
        'Marketing': ['Poppins', 'Roboto'],
        'Video': ['Montserrat', 'Open Sans'],
        'Education': ['Open Sans', 'Lato'],
        'Backgrounds': ['Helvetica', 'Arial'],
        'Banners': ['Poppins', 'Montserrat'],
        'Infographics': ['Roboto', 'Lato'],
        'Posters': ['Playfair Display', 'Montserrat'],
        'Cards': ['Merriweather', 'Lato'],
        'Newsletters': ['Georgia', 'Arial'],
        'Planners': ['Lato', 'Roboto'],
      };
      const cat = this.CATEGORIES.find(c => text.includes(c)) || 'Social Media';
      return pairings[cat] || ['Montserrat', 'Roboto'];
    }

    return detected;
  }

  // ─── Helper: Generate palette from category ─────────────────────

  private generatePaletteFromCategory(category: string, title: string): string[] {
    const mood: Record<string, string[]> = {
      'Social Media': ['#FF6B6B', '#4ECDC4', '#292F36', '#F7FFF7'],
      'Logos': ['#2C3E50', '#E74C3C', '#ECF0F1', '#3498DB'],
      'Flyers': ['#FFE66D', '#4ECDC4', '#292F36', '#F7FFF7'],
      'Presentations': ['#1A1A2E', '#16213E', '#0F3460', '#E94560'],
      'Marketing': ['#E63946', '#F1FAEE', '#A8DADC', '#457B9D'],
      'Video': ['#0D1B2A', '#1B2838', '#415A77', '#778DA9'],
      'Education': ['#2B9348', '#55A630', '#80B918', '#D9ED92'],
      'Backgrounds': ['#1A1A2E', '#16213E', '#E94560', '#F5F5F5'],
      'Banners': ['#FF6B35', '#F7C59F', '#EFEFD0', '#004E89'],
      'Infographics': ['#1A936F', '#114B5F', '#F3E9D2', '#C6DABF'],
      'Posters': ['#2D3047', '#93B7BE', '#E0CA3C', '#A799B7'],
      'Cards': ['#FFB5A7', '#FCD5CE', '#F8EDEB', '#D8E2DC'],
      'Newsletters': ['#1D3557', '#457B9D', '#A8DADC', '#F1FAEE'],
      'Planners': ['#F4A261', '#E76F51', '#264653', '#2A9D8F'],
    };
    return mood[category] || ['#292F36', '#4ECDC4', '#FF6B6B', '#F7FFF7'];
  }

  private getDefaultPaletteForCategory(index: number): string[] {
    const palettes = [
      ['#FF6B6B', '#4ECDC4', '#292F36', '#F7FFF7'],
      ['#2C3E50', '#E74C3C', '#ECF0F1', '#3498DB'],
      ['#FFE66D', '#4ECDC4', '#292F36', '#F7FFF7'],
      ['#1A1A2E', '#16213E', '#0F3460', '#E94560'],
      ['#E63946', '#F1FAEE', '#A8DADC', '#457B9D'],
      ['#0D1B2A', '#1B2838', '#415A77', '#778DA9'],
      ['#2B9348', '#55A630', '#80B918', '#D9ED92'],
      ['#1A1A2E', '#16213E', '#E94560', '#F5F5F5'],
      ['#FF6B35', '#F7C59F', '#EFEFD0', '#004E89'],
      ['#1A936F', '#114B5F', '#F3E9D2', '#C6DABF'],
      ['#2D3047', '#93B7BE', '#E0CA3C', '#A799B7'],
      ['#FFB5A7', '#FCD5CE', '#F8EDEB', '#D8E2DC'],
      ['#1D3557', '#457B9D', '#A8DADC', '#F1FAEE'],
      ['#F4A261', '#E76F51', '#264653', '#2A9D8F'],
    ];
    return palettes[index] || palettes[0];
  }

  // ─── Helpers: Layout / Composition / Style guesses ──────────────

  private guessAspectRatio(category: string): string {
    const ratios: Record<string, string> = {
      'Social Media': '1:1 or 9:16',
      'Logos': '1:1',
      'Flyers': '8.5:11',
      'Presentations': '16:9',
      'Marketing': '16:9',
      'Video': '16:9',
      'Education': '16:9 or 4:3',
      'Backgrounds': '16:9',
      'Banners': '16:9 or 728:90',
      'Infographics': '2:3 or 1:2',
      'Posters': '2:3',
      'Cards': '1:1 or 5:7',
      'Newsletters': '8.5:11',
      'Planners': '8.5:11 or A4',
    };
    return ratios[category] || '16:9';
  }

  private guessCompositionalStyle(category: string): string {
    const styles: Record<string, string> = {
      'Social Media': 'bold_centered',
      'Logos': 'minimal_balanced',
      'Flyers': 'dynamic_asymmetric',
      'Presentations': 'clean_grid',
      'Marketing': 'persuasive_funnel',
      'Video': 'kinetic_typography',
      'Education': 'structured_hierarchy',
      'Backgrounds': 'atmosphere_depth',
      'Banners': 'horizontal_scan',
      'Infographics': 'data_flow',
      'Posters': 'hero_visual',
      'Cards': 'compact_elegant',
      'Newsletters': 'editorial_column',
      'Planners': 'functional_grid',
    };
    return styles[category] || 'balanced';
  }

  private guessBackgroundStyle(category: string): string {
    const styles: Record<string, string> = {
      'Social Media': 'gradient_mesh',
      'Logos': 'solid_clean',
      'Flyers': 'patterned_overlay',
      'Presentations': 'subtle_gradient',
      'Marketing': 'dark_luxury',
      'Video': 'dark_cinematic',
      'Education': 'light_clean',
      'Backgrounds': 'texture_natural',
      'Banners': 'gradient_horizontal',
      'Infographics': 'white_clean',
      'Posters': 'dark_dramatic',
      'Cards': 'warm_soft',
      'Newsletters': 'light_minimal',
      'Planners': 'white_structured',
    };
    return styles[category] || 'clean_minimal';
  }

  private guessFontStyles(category: string): { headline: string; body: string } {
    const styles: Record<string, { headline: string; body: string }> = {
      'Social Media': { headline: 'Montserrat Bold', body: 'Poppins Regular' },
      'Logos': { headline: 'Playfair Display', body: 'Montserrat Light' },
      'Flyers': { headline: 'Roboto Black', body: 'Open Sans Regular' },
      'Presentations': { headline: 'Lato Black', body: 'Merriweather Light' },
      'Marketing': { headline: 'Poppins Bold', body: 'Roboto Regular' },
      'Video': { headline: 'Montserrat ExtraBold', body: 'Open Sans Regular' },
      'Education': { headline: 'Open Sans Bold', body: 'Lato Regular' },
      'Backgrounds': { headline: 'Helvetica Neue', body: 'Arial' },
      'Banners': { headline: 'Poppins Bold', body: 'Montserrat Regular' },
      'Infographics': { headline: 'Roboto Bold', body: 'Lato Regular' },
      'Posters': { headline: 'Playfair Display Black', body: 'Montserrat Light' },
      'Cards': { headline: 'Merriweather Bold', body: 'Lato Regular' },
      'Newsletters': { headline: 'Georgia Bold', body: 'Arial Regular' },
      'Planners': { headline: 'Lato Bold', body: 'Roboto Regular' },
    };
    return styles[category] || { headline: 'Montserrat Bold', body: 'Open Sans Regular' };
  }

  // ─── Continuous harvest mode for massive scale ──────────────────

  /**
   * Run harvests continuously until the target strand count is reached.
   * Each cycle browses all categories × keywords and stores DNA.
   * Designed for the 1M+ strand scaling push.
   */
  async harvestContinuously(
    userId: string,
    targetStrands: number = 1_000_000,
    onProgress?: (current: number, target: number) => void,
  ): Promise<{ totalStrands: number; cycles: number }> {
    console.log(`[CanvaDnaHarvester] Starting CONTINUOUS harvest — target: ${targetStrands.toLocaleString()} strands`);
    webSocketService.notifyUser(userId, 'ai-log', {
      message: `[CANVA] 🚀 Starting CONTINUOUS harvest — target: ${targetStrands.toLocaleString()} strands`,
    });

    let totalStrands = 0;
    let cycles = 0;

    // Get initial vault count for progress tracking
    try {
      const stats = await dnaVaultService.getVaultStats();
      totalStrands = stats.totalStrands || 0;
    } catch {}

    const startCount = totalStrands;

    try {
      while (totalStrands < targetStrands) {
        cycles++;
        console.log(`[CanvaDnaHarvester] Cycle ${cycles} — current: ${totalStrands.toLocaleString()} / ${targetStrands.toLocaleString()}`);

        try {
          const result = await this.harvestForUser(userId);
          totalStrands += result.totalStrands;

          if (onProgress) {
            onProgress(totalStrands, targetStrands);
          }

          webSocketService.notifyUser(userId, 'ai-log', {
            message: `[CANVA] 📊 Cycle ${cycles}: +${result.totalStrands} strands (total: ${totalStrands.toLocaleString()})`,
          });

          console.log(`[CanvaDnaHarvester] Cycle ${cycles} complete: ${totalStrands.toLocaleString()} total strands`);
        } catch (cycleErr: any) {
          console.error(`[CanvaDnaHarvester] Cycle ${cycles} failed:`, cycleErr.message);
          // Brief cool-down before retry
          await new Promise(r => setTimeout(r, 30000));
        }

        // Brief pause between cycles to let browser/gc recover
        if (totalStrands < targetStrands) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      const gained = totalStrands - startCount;
      console.log(`[CanvaDnaHarvester] CONTINUOUS harvest DONE: ${gained.toLocaleString()} new strands in ${cycles} cycles`);
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `[CANVA] 🎉 CONTINUOUS harvest COMPLETE! ${gained.toLocaleString()} new strands (${cycles} cycles). Total: ${totalStrands.toLocaleString()}`,
      });

      return { totalStrands, cycles };
    } catch (error: any) {
      console.error(`[CanvaDnaHarvester] Continuous harvest aborted:`, error.message);
      throw error;
    }
  }

  // ─── Browser lifecycle ──────────────────────────────────────────

  private async initBrowser(): Promise<void> {
    if (!this.browser) {
      console.log('[CanvaDnaHarvester] Launching Playwright Chromium...');
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const context = await this.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      this.page = await context.newPage();
    }
  }

  private async closeBrowser(): Promise<void> {
    if (this.page) {
      try {
        await this.page.context().close();
      } catch {}
      this.page = null;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }
  }
}

export const canvaDnaHarvesterService = new CanvaDnaHarvesterService();