import { chromium, Browser, Page } from 'playwright';
import { v4 as uuidv4 } from 'uuid';
import { notificationService } from './notificationService.js';
import { approvalService } from './approvalService.js';

export interface AutomationStep {
  action: 'navigate' | 'click' | 'fill' | 'screenshot' | 'approve' | 'wait' | 'extract';
  selector?: string;
  value?: string;
  url?: string;
}

export class NeuralBrowserService {
  private browser: Browser | null = null;

  async init() {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async executeAutomation(userId: string, steps: AutomationStep[]) {
    await this.init();
    const context = await this.browser!.newContext();
    const page = await context.newPage();
    const results: Record<string, string | null> = {};

    try {
      for (const step of steps) {
        console.log(`Executing step: ${step.action} ${step.url || step.selector || ''}`);
        
        switch (step.action) {
          case 'navigate':
            if (step.url) await page.goto(step.url);
            break;
          case 'click':
            if (step.selector) await page.click(step.selector);
            break;
          case 'fill':
            if (step.selector && step.value) await page.fill(step.selector, step.value);
            break;
          case 'wait':
            if (step.value) {
                if (step.value.startsWith('http')) {
                    await page.waitForURL(step.value, { timeout: 60000 });
                } else {
                    await page.waitForSelector(step.value, { timeout: 60000 });
                }
            }
            break;
          case 'extract':
            if (step.selector) {
                const value = await page.textContent(step.selector);
                results[step.selector] = value;
            }
            break;
          case 'screenshot':
            await this.takeAndSaveScreenshot(userId, page, 'Manual Step Verification');
            break;
          case 'approve':
            await this.requestHumanApproval(userId, page, step.value || 'Sensitive Action Approval');
            break;
        }
      }
      return results;
    } catch (error) {
      console.error('Automation execution failed:', error);
      throw error;
    } finally {
      await context.close();
    }
  }

  private async takeAndSaveScreenshot(userId: string, page: Page, message: string) {
    const screenshot = await page.screenshot();
    const screenshotUrl = await this.saveScreenshotToPublic(screenshot);
    
    await notificationService.sendNotification(userId, {
      type: 'AUTOMATION_SCREENSHOT',
      title: 'Automation Snapshot',
      message: message,
      metadata: { screenshotUrl }
    });

    return screenshotUrl;
  }

  private async requestHumanApproval(userId: string, page: Page, reason: string) {
    const screenshot = await page.screenshot();
    const screenshotUrl = await this.saveScreenshotToPublic(screenshot);
    
    console.log(`[NeuralBrowser] Requesting human approval for user ${userId}: ${reason}`);
    
    await approvalService.createRequest(
      userId,
      'content', // Using content type for now as it fits the UI flow
      `Approval required for automated action: ${reason}`,
      { 
        screenshotUrl,
        pageUrl: page.url(),
        requiresManualResume: true
      }
    );

    // In a real implementation, we would pause the execution and wait for a webhook or websocket signal
    // For this prototype, we'll throw an interrupt-like error or just log it.
    throw new Error('HUMAN_APPROVAL_REQUIRED');
  }

  private async saveScreenshotToPublic(buffer: Buffer): Promise<string> {
    const filename = `screenshot-${uuidv4()}.png`;
    const path = `./public/assets/screenshots/${filename}`;
    
    // Ensure directory exists
    const fs = await import('fs');
    if (!fs.existsSync('./public/assets/screenshots')) {
        fs.mkdirSync('./public/assets/screenshots', { recursive: true });
    }
    fs.writeFileSync(path, buffer);

    return `${process.env.BACKEND_URL || 'http://localhost:3000'}/assets/screenshots/${filename}`;
  }
}

export const neuralBrowserService = new NeuralBrowserService();
