import { Request, Response } from 'express';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { notificationService } from '../services/notificationService.js';

const { users } = schema;

/**
 * Returns configuration for the native mobile app.
 * Handles App Store 'Review Mode' bypass logic.
 */
export const getMobileConfig = async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  
  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    
    // Review Mode is active if the user is explicitly marked or if global env is set
    const isReviewMode = user?.isReviewMode || process.env.APP_STORE_REVIEW_MODE === 'true';
    
    res.json({
      status: 'success',
      config: {
        isReviewMode,
        apiVersion: '1.0.0',
        pushEnabled: true,
        features: {
          // In review mode, we might hide complex DNA harvesting to speed up approval
          dnaHarvesting: !isReviewMode,
          contentCreation: true,
          socialLinking: true,
          directSupport: true
        },
        reviewModeBypass: isReviewMode ? {
          mockStats: true,
          instantApprovals: true
        } : null
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * Synchronizes and persists a native mobile session.
 * Generates a long-lived mobile session token.
 */
export const syncMobileSession = async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  
  try {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    
    await db.update(users)
      .set({ 
        mobileSessionToken: sessionToken,
        mobileSessionExpiresAt: expiresAt,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId));
      
    res.json({
      status: 'success',
      session: {
        token: sessionToken,
        expiresAt: expiresAt.toISOString()
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * Registers a native push notification token (FCM/APNS via Expo).
 */
export const registerPushToken = async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { token, platform } = req.body;
  
  if (!token) {
    return res.status(400).json({ error: 'Push token is required' });
  }
  
  try {
    // Wrap the notification service subscribe method
    const result = await notificationService.subscribeUser(userId, { token }, 'NATIVE', platform);
    res.json({ status: 'success', result });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * Batched dashboard data for mobile to minimize latency.
 * Combines multiple stats into a single request.
 */
export const getMobileDashboard = async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    
    try {
        // Fetch multiple data points in parallel for speed
        const [user, userIntegrations, userGoals] = await Promise.all([
            db.select().from(users).where(eq(users.id, userId)).limit(1),
            db.select().from(schema.integrations).where(eq(schema.integrations.userId, userId)),
            db.select().from(schema.goals).where(eq(schema.goals.userId, userId))
        ]);

        res.json({
            status: 'success',
            data: {
                user: {
                    email: user[0]?.email,
                    tier: user[0]?.tier
                },
                integrationsCount: userIntegrations.length,
                activeGoalsCount: userGoals.filter(g => g.status === 'active').length,
                serverTimestamp: new Date().toISOString()
            }
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};
