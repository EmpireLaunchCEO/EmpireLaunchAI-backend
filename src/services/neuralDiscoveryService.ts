import { db } from '../db/index.js';
import { discoveryResults, ownershipVault } from '../db/sqlite-schema.js';
import { gmailService } from './gmailService.js';
import { imapGatewayService, ImapConfig } from './imapGatewayService.js';
import { encrypt, decrypt, encryptWithEnvelope } from '../utils/encryption.js';
import { v4 as uuidv4 } from 'uuid';
import { eq, and } from 'drizzle-orm';

export interface DiscoveryMatch {
  platform: string;
  key: string;
  type: string;
  snippet: string;
}

export class NeuralDiscoveryService {
  private patterns = [
    { platform: 'ETSY', regex: /keystring[:\s]+([a-z0-9]{32,64})/i, type: 'API_KEY' },
    { platform: 'ETSY', regex: /shared[:\s]secret[:\s]+([a-z0-9]{32,64})/i, type: 'CLIENT_SECRET' },
    { platform: 'META', regex: /app[:\s]id[:\s]+([0-9]{10,20})/i, type: 'APP_ID' },
    { platform: 'META', regex: /app[:\s]secret[:\s]+([a-z0-9]{32})/i, type: 'CLIENT_SECRET' },
    { platform: 'STRIPE', regex: /(sk_live_[a-z0-9]{24,})/i, type: 'API_KEY' },
    { platform: 'GENERIC', regex: /api[_-]key[:\s]+([a-z0-9]{32,128})/i, type: 'API_KEY' },
    { platform: 'GENERIC', regex: /client[_-]secret[:\s]+([a-z0-9]{32,128})/i, type: 'CLIENT_SECRET' },
  ];

  async scanGmail(userId: string, accessToken: string) {
    console.log(`[NeuralDiscovery] Starting Gmail scan for user ${userId}...`);
    
    const query = 'subject:("API Key" OR "Secret" OR "Token" OR "Credential") OR "API Key" OR "Client Secret"';
    const messagesData = await gmailService.listMessages(accessToken, 20); 
    const messages = messagesData.messages || [];

    const matches: DiscoveryMatch[] = [];

    for (const msgInfo of messages) {
      const message = await gmailService.getMessage(accessToken, msgInfo.id);
      const body = this.extractBody(message);
      
      this.findMatchesInBody(body, matches);
    }

    await this.saveDiscoveryResults(userId, matches);
    return matches.length;
  }

  async scanImap(userId: string, config: ImapConfig) {
    console.log(`[NeuralDiscovery] Starting IMAP scan for user ${userId} on ${config.host}...`);
    
    // Convert our internal patterns to the format expected by the IMAP gateway
    const imapPatterns = this.patterns.map(p => ({
      platform: p.platform,
      regex: p.regex,
      type: p.type
    }));

    const matches = await imapGatewayService.scan(config, imapPatterns);
    
    await this.saveDiscoveryResults(userId, matches);
    return matches.length;
  }

  private findMatchesInBody(body: string, matches: DiscoveryMatch[]) {
    for (const pattern of this.patterns) {
      const match = body.match(pattern.regex);
      if (match) {
        const rawKey = match[1];
        const startIdx = Math.max(0, match.index! - 50);
        const endIdx = Math.min(body.length, match.index! + match[0].length + 50);
        const snippet = body.substring(startIdx, endIdx).replace(/\n/g, ' ');

        matches.push({
          platform: pattern.platform,
          key: rawKey,
          type: pattern.type,
          snippet: `...${snippet}...`
        });
      }
    }
  }

  private async saveDiscoveryResults(userId: string, matches: DiscoveryMatch[]) {
    for (const m of matches) {
      const existing = await db.select().from(discoveryResults).where(
        and(
          eq(discoveryResults.userId, userId),
          eq(discoveryResults.potentialKeyMasked, this.maskKey(m.key))
        )
      ).limit(1);

      if (existing.length === 0) {
        await db.insert(discoveryResults).values({
          id: uuidv4(),
          userId,
          platform: m.platform,
          snippet: m.snippet,
          potentialKeyMasked: this.maskKey(m.key),
          rawKeyEncrypted: encrypt(m.key), 
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
    }
  }

  async approveCredential(userId: string, discoveryId: string) {
    const [result] = await db.select().from(discoveryResults).where(
      and(
        eq(discoveryResults.id, discoveryId),
        eq(discoveryResults.userId, userId)
      )
    ).limit(1);

    if (!result || result.status !== 'pending') {
      throw new Error('Discovery result not found or already processed');
    }

    const rawKey = decrypt(result.rawKeyEncrypted);
    
    // Envelope Encryption for the vault
    const { encryptedValue, encryptedDek, iv, tag } = encryptWithEnvelope(rawKey);

    // Add to Ownership Vault
    await db.insert(ownershipVault).values({
      id: uuidv4(),
      userId,
      platform: result.platform,
      secretType: 'API_KEY',
      encryptedValue,
      encryptedDek,
      iv,
      tag,
      lastRotated: new Date(),
      createdAt: new Date()
    });

    // Update status
    await db.update(discoveryResults)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(discoveryResults.id, discoveryId));

    return { success: true };
  }

  async rejectCredential(userId: string, discoveryId: string) {
    await db.update(discoveryResults)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(
        eq(discoveryResults.id, discoveryId),
        eq(discoveryResults.userId, userId)
      ));
    
    return { success: true };
  }

  // Aliases for discoveryController
  async discover(userId: string) {
    // Mock discovery for now or trigger gmail scan
    return this.scanGmail(userId, 'mock-token');
  }

  async approveDiscovery(discoveryId: string) {
    return this.approveCredential('default-user', discoveryId);
  }

  async rejectDiscovery(discoveryId: string) {
    return this.rejectCredential('default-user', discoveryId);
  }

  private extractBody(message: any): string {
    if (message.payload.parts) {
      const part = message.payload.parts.find((p: any) => p.mimeType === 'text/plain');
      if (part && part.body.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    if (message.payload.body && message.payload.body.data) {
       return Buffer.from(message.payload.body.data, 'base64').toString('utf8');
    }
    return message.snippet || '';
  }

  private maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return `${key.substring(0, 4)}****${key.substring(key.length - 4)}`;
  }
}

export const neuralDiscoveryService = new NeuralDiscoveryService();
