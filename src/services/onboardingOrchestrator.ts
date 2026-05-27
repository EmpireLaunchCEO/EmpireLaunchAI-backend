import { db, schema } from '../db/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import { encryptWithEnvelope } from '../utils/encryption.js';

const execPromise = promisify(exec);
const { onboardingSessions, ownershipVault } = schema;

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

    // Start browser agent in background
    this.runBrowserAgent(sessionId, userId, platform).catch(err => {
      console.error(`[OnboardingOrchestrator] Browser agent failed for session ${sessionId}:`, err);
    });

    return { sessionId };
  }

  private async runBrowserAgent(sessionId: string, userId: string, platform: string) {
    console.log(`[OnboardingOrchestrator] Starting browser agent for ${platform} (Session: ${sessionId})`);
    
    try {
      if (platform.toLowerCase() === 'canva') {
        await this.executeCanvaFlow(sessionId, userId);
      } else if (platform.toLowerCase() === 'etsy') {
        await this.executeEtsyFlow(sessionId, userId);
      } else if (platform.toLowerCase() === 'tiktok') {
        await this.executeTikTokFlow(sessionId, userId);
      } else if (['fiverr', 'youtube', 'instagram', 'facebook', 'gmail'].includes(platform.toLowerCase())) {
        await this.executeGenericBrowserLogin(sessionId, userId, platform.toLowerCase());
      } else {
        throw new Error(`Platform ${platform} not supported yet`);
      }
    } catch (error: any) {
      await db.update(onboardingSessions)
        .set({ status: 'failed', error: error.message, updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
    }
  }

  private async executeCanvaFlow(sessionId: string, userId: string) {
    const sessionEnv = { ...process.env, AGENT_BROWSER_SESSION: sessionId };
    
    // 1. Open Canva login
    await this.runCommand('agent-browser open "https://www.canva.com/login"', sessionEnv);
    
    // 2. Check if login is required
    const { stdout: snapshot } = await this.runCommand('agent-browser snapshot -i', sessionEnv);
    
    if (snapshot.includes('Log in')) {
      // Pause and wait for HITL
      await db.update(onboardingSessions)
        .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      
      console.log(`[OnboardingOrchestrator] HITL Required for session ${sessionId}: User must log in`);
      
      // In a real system, we'd wait for a signal from the frontend.
      // For this MVP/Playbook, we'll poll the session status or wait for the URL change.
      // The playbook used: agent-browser wait --url "**/home" --timeout 300000
      
      try {
        await this.runCommand('agent-browser wait --url "**/home" --timeout 300000', sessionEnv);
      } catch (e) {
        throw new Error('Login timeout or failed');
      }
    }

    // 3. Resume Autonomy: Filling Profile / Connecting
    await db.update(onboardingSessions)
      .set({ status: 'in_progress', currentState: 'RESUMING_AUTONOMY', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));

    await this.runCommand('agent-browser navigate "https://www.canva.com/settings/apps"', sessionEnv);
    await this.runCommand('agent-browser wait --load networkidle', sessionEnv);

    // Mocking the Connect flow for Canva as per playbook
    // In a real scenario, we'd interact with specific elements
    await db.update(onboardingSessions)
      .set({ currentState: 'CONNECTING_APP', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));
    
    // Example interaction (commented out in playbook but we'll simulate the state transition)
    // await this.runCommand('agent-browser click "@connect_button"', sessionEnv);
    
    // 4. Extraction & Handoff
    await db.update(onboardingSessions)
      .set({ currentState: 'EXTRACTING_CREDENTIALS', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));

    // For Canva MVP, we'll simulate finding a token/key
    const mockApiKey = `cv_${uuidv4().replace(/-/g, '')}`;
    
    // Envelope Encryption for the vault
    const { encryptedValue, encryptedDek, iv, tag } = encryptWithEnvelope(mockApiKey);

    // Add to Ownership Vault
    await db.insert(ownershipVault).values({
      id: uuidv4(),
      userId,
      platform: 'CANVA',
      secretType: 'API_KEY',
      encryptedValue,
      encryptedDek,
      iv,
      tag,
      lastRotated: new Date(),
      createdAt: new Date()
    });

    // 5. Completion
    await db.update(onboardingSessions)
      .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));
    
    await this.runCommand('agent-browser close', sessionEnv);
    console.log(`[OnboardingOrchestrator] Onboarding completed for session ${sessionId}`);
  }

  private async executeEtsyFlow(sessionId: string, userId: string) {
    const sessionEnv = { ...process.env, AGENT_BROWSER_SESSION: sessionId };
    
    // 1. Open Etsy login
    await this.runCommand('agent-browser open "https://www.etsy.com/signin"', sessionEnv);
    
    // 2. Check if login is required
    const { stdout: snapshot } = await this.runCommand('agent-browser snapshot -i', sessionEnv);
    
    if (snapshot.includes('Email address')) {
      // Pause and wait for HITL
      await db.update(onboardingSessions)
        .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      
      console.log(`[OnboardingOrchestrator] HITL Required for session ${sessionId}: User must log in to Etsy`);
      
      try {
        // Wait for the shop manager or home page to indicate login success
        await this.runCommand('agent-browser wait --url "**/your/shop**" --timeout 300000', sessionEnv);
      } catch (e) {
        throw new Error('Etsy login timeout or failed');
      }
    }

    // 3. Resume Autonomy: Navigate to Shop About Section
    await db.update(onboardingSessions)
      .set({ status: 'in_progress', currentState: 'RESUMING_AUTONOMY', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));

    // Get user's goal to fill profile
    const latestGoal = await this.getLatestUserGoal(userId);
    const goalText = latestGoal ? latestGoal.description || latestGoal.title : "Digital Marketing Empire";

    await this.runCommand('agent-browser navigate "https://www.etsy.com/your/shop/about"', sessionEnv);
    await this.runCommand('agent-browser wait --load networkidle', sessionEnv);

    // 4. Fill Profile
    await db.update(onboardingSessions)
      .set({ currentState: 'FILLING_PROFILE', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));

    await this.runCommand(`agent-browser fill "@about_text_area" "${goalText}"`, sessionEnv);
    await this.runCommand('agent-browser click "@save_button"', sessionEnv);
    
    // 5. Extraction & Handoff (Simulated for MVP, similar to Canva)
    await db.update(onboardingSessions)
      .set({ currentState: 'EXTRACTING_CREDENTIALS', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));

    const mockEtsyKey = `et_${uuidv4().replace(/-/g, '')}`;
    const { encryptedValue, encryptedDek, iv, tag } = encryptWithEnvelope(mockEtsyKey);

    await db.insert(ownershipVault).values({
      id: uuidv4(),
      userId,
      platform: 'ETSY',
      secretType: 'SESSION_TOKEN',
      encryptedValue,
      encryptedDek,
      iv,
      tag,
      lastRotated: new Date(),
      createdAt: new Date()
    });

    // 6. Completion
    await db.update(onboardingSessions)
      .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));
    
    await this.runCommand('agent-browser close', sessionEnv);
    console.log(`[OnboardingOrchestrator] Etsy onboarding completed for session ${sessionId}`);
  }

  private async executeTikTokFlow(sessionId: string, userId: string) {
    const sessionEnv = { ...process.env, AGENT_BROWSER_SESSION: sessionId };
    
    // 1. Open TikTok Authorize (Simulated URL for MVP)
    await this.runCommand('agent-browser open "https://www.tiktok.com/auth/authorize?client_key=EMPIRE_ID&scope=user.info.basic,video.list,video.upload&redirect_uri=https://empirelaunch.ai/auth/callback/tiktok"', sessionEnv);
    
    // 2. Check if login/authorization is required
    const { stdout: snapshot } = await this.runCommand('agent-browser snapshot -i', sessionEnv);
    
    if (snapshot.includes('Login') || snapshot.includes('Authorize')) {
      // Pause and wait for HITL
      await db.update(onboardingSessions)
        .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      
      console.log(`[OnboardingOrchestrator] HITL Required for session ${sessionId}: User must authorize TikTok`);
      
      try {
        // Wait for the redirect back to our callback URL
        await this.runCommand('agent-browser wait --url "**/auth/callback/tiktok*" --timeout 300000', sessionEnv);
      } catch (e) {
        throw new Error('TikTok authorization timeout or failed');
      }
    }

    // 3. Verification
    await db.update(onboardingSessions)
      .set({ status: 'in_progress', currentState: 'VERIFYING_CONNECTION', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));

    // For TikTok, we simulate verifying the code/token
    await this.runCommand('agent-browser wait --load networkidle', sessionEnv);
    
    // 4. Handoff to Vault
    await db.update(onboardingSessions)
      .set({ currentState: 'EXTRACTING_CREDENTIALS', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));

    const mockTikTokToken = `tt_${uuidv4().replace(/-/g, '')}`;
    const { encryptedValue, encryptedDek, iv, tag } = encryptWithEnvelope(mockTikTokToken);

    await db.insert(ownershipVault).values({
      id: uuidv4(),
      userId,
      platform: 'TIKTOK',
      secretType: 'OAUTH_REFRESH',
      encryptedValue,
      encryptedDek,
      iv,
      tag,
      lastRotated: new Date(),
      createdAt: new Date()
    });

    // 5. Completion
    await db.update(onboardingSessions)
      .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));
    
    await this.runCommand('agent-browser close', sessionEnv);
    console.log(`[OnboardingOrchestrator] TikTok onboarding completed for session ${sessionId}`);
  }

  private async executeGenericBrowserLogin(sessionId: string, userId: string, platform: string) {
    const sessionEnv = { ...process.env, AGENT_BROWSER_SESSION: sessionId };
    const urls: Record<string, string> = {
      fiverr: 'https://www.fiverr.com/login',
      youtube: 'https://accounts.google.com/ServiceLogin?service=youtube',
      instagram: 'https://www.instagram.com/accounts/login/',
      facebook: 'https://www.facebook.com/login',
      gmail: 'https://accounts.google.com/ServiceLogin?service=mail'
    };

    const waitUrls: Record<string, string> = {
      fiverr: '**/dashboard**',
      youtube: '**/home**',
      instagram: '**/home**',
      facebook: '**/home**',
      gmail: '**/mail**'
    };

    const url = urls[platform];
    const waitUrl = waitUrls[platform];

    await this.runCommand(`agent-browser open "${url}"`, sessionEnv);
    
    // Check if login is required
    const { stdout: snapshot } = await this.runCommand('agent-browser snapshot -i', sessionEnv);
    
    if (snapshot.includes('Log in') || snapshot.includes('Sign in') || snapshot.includes('Email')) {
      await db.update(onboardingSessions)
        .set({ status: 'hitl_required', currentState: 'LOGIN_REQUIRED', updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
      
      try {
        await this.runCommand(`agent-browser wait --url "${waitUrl}" --timeout 300000`, sessionEnv);
      } catch (e) {
        throw new Error(`${platform} login timeout or failed`);
      }
    }

    await db.update(onboardingSessions)
      .set({ status: 'in_progress', currentState: 'EXTRACTING_CREDENTIALS', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));

    // Simulate extraction
    const mockToken = `gen_${uuidv4().replace(/-/g, '')}`;
    const { encryptedValue, encryptedDek, iv, tag } = encryptWithEnvelope(mockToken);

    await db.insert(ownershipVault).values({
      id: uuidv4(),
      userId,
      platform: platform.toUpperCase(),
      secretType: 'SESSION_TOKEN',
      encryptedValue,
      encryptedDek,
      iv,
      tag,
      lastRotated: new Date(),
      createdAt: new Date()
    });

    await db.update(onboardingSessions)
      .set({ status: 'completed', currentState: 'COMPLETED', updatedAt: new Date() })
      .where(eq(onboardingSessions.id, sessionId));
    
    await this.runCommand('agent-browser close', sessionEnv);
    console.log(`[OnboardingOrchestrator] ${platform} onboarding completed for session ${sessionId}`);
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

  private async runCommand(command: string, env: any) {
    console.log(`[OnboardingOrchestrator] Executing: ${command}`);
    return execPromise(command, { env });
  }

  async getSessionStatus(sessionId: string) {
    const [session] = await db.select().from(onboardingSessions).where(eq(onboardingSessions.id, sessionId)).limit(1);
    return session;
  }
}

export const onboardingOrchestrator = new OnboardingOrchestrator();
