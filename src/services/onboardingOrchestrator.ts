import { db, schema } from '../db/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import { encryptWithEnvelope } from '../utils/encryption.js';
import { onboardingQueue, aiTaskQueue, neuralBrowserQueue } from './queueService.js';
import { webSocketService } from './websocketService.js';
import { dnaHuntOrchestrator } from './dnaHuntOrchestrator.js';

const execPromise = promisify(exec);
const { onboardingSessions, ownershipVault, goals } = schema;

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

    // Add onboarding task to the queue
    await onboardingQueue.add('onboarding-task', {
      sessionId,
      userId,
      platform,
    });

    return { sessionId };
  }

  // Moved to onboardingWorker.ts for async execution
  public async processOnboarding(sessionId: string, userId: string, platform: string) {
    console.log(`[OnboardingOrchestrator] Processing onboarding for ${platform} (Session: ${sessionId})`);
    
    try {
      let userNiche: string | undefined;

      // Get the user's niche from their latest goal
      const latestGoal = await this.getLatestUserGoal(userId);
      if (latestGoal?.description) {
        // Extract niche from goal description (format: "Empire Niche: X. Angle: Y. Mode: Z")
        const nicheMatch = latestGoal.description.match(/Empire Niche:\s*([^.]+)/i);
        if (nicheMatch) {
          userNiche = nicheMatch[1].trim();
        }
      }

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

      // ─── DNA HUNT TRIGGER ───────────────────────────────────────────────
      // Immediately after successful onboarding, start automated DNA hunting
      // on the linked platform to extract top-performing Style DNA.
      webSocketService.notifyUser(userId, 'ai-log', {
        message: `[ONBOARD] ✅ ${platform} linked! Initiating automated Style DNA harvest on ${platform}...`
      });

      await dnaHuntOrchestrator.triggerHunt(userId, platform, userNiche);
      console.log(`[OnboardingOrchestrator] DNA Hunt triggered for user ${userId} on ${platform} (niche: ${userNiche || 'auto-detect'})`);

    } catch (error: any) {
      await db.update(onboardingSessions)
        .set({ status: 'failed', error: error.message, updatedAt: new Date() })
        .where(eq(onboardingSessions.id, sessionId));
    }
  }

  public async initializeEmpire(userId: string, name: string, niche: string, angle: string, automationMode: string, goalId?: string) {
    console.log(`[OnboardingOrchestrator] Initializing Empire for user ${userId}: ${name} (GoalId: ${goalId})`);
    
    webSocketService.notifyUser(userId, 'ai-log', { message: `[SYSTEM] Starting Empire initialization: ${name}` });
    
    let targetGoalId = goalId;

    if (!targetGoalId) {
      // Fallback: Create the primary goal (The Empire) if not already created
      const [newGoal] = await db.insert(goals).values({
        id: uuidv4(),
        userId,
        title: name,
        description: `Empire Niche: ${niche}. Angle: ${angle}. Mode: ${automationMode}`,
        status: 'pending',
        approvalRequired: automationMode !== 'full_autopilot',
        autoPost: automationMode === 'full_autopilot',
        createdAt: new Date(),
        updatedAt: new Date()
      }).returning();
      targetGoalId = newGoal.id;
    }

    webSocketService.notifyUser(userId, 'ai-log', { message: `[NEURAL] Mapping growth architecture for ${niche}...` });

    // 2. Queue the initial strategic job
    await aiTaskQueue.add('goal-initial-job', {
      goal: name,
      userId,
      context: {
        goalId: targetGoalId,
        goal: niche,
        angle,
        automationMode
      }
    });

    webSocketService.notifyUser(userId, 'ai-log', { message: `[SYSTEM] Strategic roadmap generation queued.` });

    // 3. Update status to 'active'
    await db.update(goals)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(goals.id, targetGoalId));

    // 3.5 Sync to User Settings for global memory
    await db.update(schema.userSettings)
      .set({
        businessNiche: niche,
        businessAngle: angle,
        updatedAt: new Date()
      })
      .where(eq(schema.userSettings.userId, userId));

    console.log(`[OnboardingOrchestrator] Empire initialized successfully for user ${userId}`);
    
    // Notify via WebSocket for completion
    webSocketService.notifyUser(userId, 'empire-initialized', {
      goalId: targetGoalId,
      status: 'active'
    });

    // ─── DNA HUNT: Search across user's already-linked platforms ─────────
    webSocketService.notifyUser(userId, 'ai-log', {
      message: `[DNA-HUNT] Scanning connected platforms for top-performing "${niche}" Style DNA...`
    });

    // Queue DNA hunts for each major creative/harvesting platform
    const huntPlatforms = ['canva', 'kittl', 'instagram', 'etsy', 'tiktok'];
    for (const platform of huntPlatforms) {
      try {
        await dnaHuntOrchestrator.triggerHunt(userId, platform, niche);
      } catch (err) {
        console.warn(`[OnboardingOrchestrator] Failed to trigger DNA hunt on ${platform}:`, (err as Error).message);
      }
    }

    webSocketService.notifyUser(userId, 'ai-log', { message: `[SYSTEM] Empire Sync Complete. Ready for takeoff.` });

    return targetGoalId;
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
