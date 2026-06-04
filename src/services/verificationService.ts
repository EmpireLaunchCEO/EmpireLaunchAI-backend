import { db } from '../db/index.js';
import { handleVerifications } from '../db/sqlite-schema.js';
import { neuralBrowserService } from './neuralBrowserService.js';
import { v4 as uuidv4 } from 'uuid';
import { eq, and } from 'drizzle-orm';

export class VerificationService {
  generateHash(): string {
    // Generate a unique 6-character alphanumeric hash
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  async initiateVerification(userId: string, platform: string, handle: string) {
    const hash = this.generateHash();
    const id = uuidv4();
    
    // Check if there's already a pending verification for this handle
    const existing = await db.select()
      .from(handleVerifications)
      .where(and(
        eq(handleVerifications.userId, userId),
        eq(handleVerifications.platform, platform),
        eq(handleVerifications.handle, handle),
        eq(handleVerifications.status, 'pending')
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(handleVerifications)
        .set({
          hash,
          updatedAt: new Date(),
        })
        .where(eq(handleVerifications.id, existing[0].id));
      return hash;
    }

    await db.insert(handleVerifications).values({
      id,
      userId,
      platform,
      handle,
      hash,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return hash;
  }

  async verifyHandle(userId: string, platform: string, handle: string) {
    const verification = await db.select()
      .from(handleVerifications)
      .where(and(
        eq(handleVerifications.userId, userId),
        eq(handleVerifications.platform, platform),
        eq(handleVerifications.handle, handle),
        eq(handleVerifications.status, 'pending')
      ))
      .limit(1);

    if (verification.length === 0) {
      throw new Error('No pending verification found');
    }

    const v = verification[0];
    const cleanHandle = handle.startsWith('@') ? handle.substring(1) : handle;
    const profileUrl = platform === 'tiktok' 
      ? `https://www.tiktok.com/@${cleanHandle}`
      : `https://www.instagram.com/${cleanHandle}/`;

    console.log(`[VerificationService] Verifying ${platform} handle ${handle} for user ${userId} at ${profileUrl}`);

    try {
      // Use neural browser to check bio with platform-specific selectors
      const bioSelector = platform === 'tiktok' ? '[data-e2e="user-bio"]' : 'header section';
      
      const results = await neuralBrowserService.executeAutomation(userId, [
        { action: 'navigate', url: profileUrl },
        { action: 'wait', value: bioSelector },
        { action: 'extract', selector: bioSelector },
      ]);

      const bioText = (results[bioSelector] || '').toUpperCase();
      console.log(`[VerificationService] Found hash in bio: ${bioText.includes(v.hash)}`);

      if (bioText.includes(v.hash)) {
        await db.update(handleVerifications)
          .set({ status: 'verified', updatedAt: new Date() })
          .where(eq(handleVerifications.id, v.id));
        
        // Also update the integrations table or notify the orchestrator
        return { success: true, message: 'Handle verified successfully' };
      } else {
        return { success: false, message: 'Verification hash not found in bio' };
      }
    } catch (error) {
      console.error(`[VerificationService] Verification failed for ${handle}:`, error);
      return { success: false, message: 'Automation failed during verification' };
    }
  }

  async getVerifiedHandles(userId: string) {
    return await db.select()
      .from(handleVerifications)
      .where(and(
        eq(handleVerifications.userId, userId),
        eq(handleVerifications.status, 'verified')
      ));
  }
}

export const verificationService = new VerificationService();
