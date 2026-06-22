import { db, schema } from '../db/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { goDaddyService } from './goDaddyService.js';
import { systemeIoService } from './systemeIoService.js';
import { integrationService } from './integrationService.js';
import { webSocketService } from './websocketService.js';
import { aiScriptingService } from './aiScriptingService.js';
import { dnaVaultService } from './dnaVaultService.js';
import { v4 as uuidv4 } from 'uuid';

const { ownershipVault, integrations } = schema;

export class AutoOnboardingService {
  /**
   * Automatically sets up DNS records for a user's GoDaddy domain.
   */
  async setupGoDaddyDns(userId: string, domain: string) {
    console.log(`[AutoOnboarding] Setting up GoDaddy DNS for user ${userId}, domain ${domain}`);
    webSocketService.notifyUser(userId, 'ai-log', { message: `[DNS] Initializing automated DNS setup for ${domain}...` });

    const creds = await integrationService.getCredentials(userId, 'godaddy');
    if (!creds) {
      throw new Error('GoDaddy not connected');
    }

    // Standard records for EmpireLaunch AI + Systeme.io Deliverability
    const records = [
      { type: 'TXT', name: '@', data: 'v=spf1 include:_spf.google.com include:systeme.io ~all', ttl: 3600 },
      { type: 'CNAME', name: 'www', data: '@', ttl: 3600 },
      { type: 'TXT', name: '_empirelaunch', data: `verification=${userId}`, ttl: 3600 },
      // Systeme.io MX records (standard)
      { type: 'MX', name: '@', data: 'mx1.systeme.io', priority: 10, ttl: 3600 },
      { type: 'MX', name: '@', data: 'mx2.systeme.io', priority: 20, ttl: 3600 },
      // Generic DKIM (often handled via CNAME in modern setups, but adding TXT placeholder)
      { type: 'TXT', name: 's1._domainkey', data: 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC...', ttl: 3600 }
    ];

    try {
      await goDaddyService.updateDns(creds.api_key, creds.api_secret, domain, records);
      webSocketService.notifyUser(userId, 'ai-log', { message: `[DNS] ✅ DNS records updated successfully for ${domain}.` });
      return { success: true };
    } catch (error: any) {
      console.error(`[AutoOnboarding] GoDaddy DNS setup failed: ${error.message}`);
      webSocketService.notifyUser(userId, 'ai-log', { message: `[DNS] ❌ DNS setup failed: ${error.message}` });
      throw error;
    }
  }

  /**
   * Automatically sets up Systeme.io email campaigns and tags.
   */
  async setupSystemeIoCampaigns(userId: string) {
    console.log(`[AutoOnboarding] Setting up Systeme.io campaigns for user ${userId}`);
    webSocketService.notifyUser(userId, 'ai-log', { message: `[Email] Initializing Systeme.io automation...` });

    const creds = await integrationService.getCredentials(userId, 'systeme_io');
    if (!creds) {
      throw new Error('Systeme.io not connected');
    }

    try {
      // 1. Create a tag for the Empire
      const tagName = 'EmpireLaunch_Lead';
      await systemeIoService.addTag(creds.api_key, tagName);
      webSocketService.notifyUser(userId, 'ai-log', { message: `[Email] Tag "${tagName}" created.` });

      // 2. Create Campaign
      const campaignName = `EmpireLaunch_Auto_Sequence_${uuidv4().substring(0, 8)}`;
      const campaign = await systemeIoService.createCampaign(creds.api_key, campaignName);
      webSocketService.notifyUser(userId, 'ai-log', { message: `[Email] Campaign "${campaignName}" created.` });

      // 3. Generate and Add 30-day sequence steps based on DNA
      // Fetch top Style DNA for the user to influence the copy
      const topStrands = await dnaVaultService.searchStrands(userId, 5); 
      const niche = (await this.getLatestUserGoal(userId))?.description || 'digital marketing';
      
      const sequence = await aiScriptingService.generateEmailSequence(userId, niche, topStrands);
      
      for (const email of sequence) {
          await systemeIoService.createCampaignStep(creds.api_key, campaign.id, {
              subject: email.subject,
              content: email.content,
              delay_days: email.day
          });
      }
      
      const accountInfo = await systemeIoService.getAccountInfo(creds.api_key);
      
      webSocketService.notifyUser(userId, 'ai-log', { message: `[Email] ✅ Systeme.io sequence (30-day) configured for ${accountInfo.handle}.` });
      return { success: true, accountInfo, campaignId: campaign.id };
    } catch (error: any) {
      console.error(`[AutoOnboarding] Systeme.io setup failed: ${error.message}`);
      webSocketService.notifyUser(userId, 'ai-log', { message: `[Email] ❌ Systeme.io setup failed: ${error.message}` });
      throw error;
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
}

export const autoOnboardingService = new AutoOnboardingService();
