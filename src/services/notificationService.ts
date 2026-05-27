import webpush from 'web-push';
import { Expo } from 'expo-server-sdk';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const { pushSubscriptions } = schema;
const expo = new Expo();

// Configure VAPID keys
if (process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.WEB_PUSH_SUBJECT || 'mailto:admin@empirelaunch.ai',
    process.env.WEB_PUSH_PUBLIC_KEY,
    process.env.WEB_PUSH_PRIVATE_KEY
  );
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  data?: {
    url: string;
    type: 'SALE_ALERT' | 'HITL_GATE' | 'GENERAL';
  };
}

export class NotificationService {
  /**
   * Sends a push notification to all active subscriptions of a user.
   */
  async sendPushNotification(userId: string, payload: PushPayload) {
    console.log(`[NotificationService] Dispatching push to user ${userId}: ${payload.title}`);

    const subscriptions = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));

    const webSubscriptions = subscriptions.filter((s: any) => s.type === 'WEB');
    const nativeSubscriptions = subscriptions.filter((s: any) => s.type === 'NATIVE');

    const results: any[] = [];

    // Handle Web Push
    const webResults = await Promise.all(
      webSubscriptions.map(async (sub: any) => {
        const pushSubscription = {
          endpoint: sub.token,
          keys: {
            auth: sub.authKey,
            p256dh: sub.p256dhKey,
          },
        };

        try {
          await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
          return { success: true, type: 'WEB', endpoint: sub.token };
        } catch (error: any) {
          console.error(`[NotificationService] WebPush Error for ${sub.token}:`, error.message);
          if (error.statusCode === 410 || error.statusCode === 404) {
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
          }
          return { success: false, type: 'WEB', error: error.message };
        }
      })
    );
    results.push(...webResults);

    // Handle Native Push (Expo)
    if (nativeSubscriptions.length > 0) {
      const messages = [];
      for (const sub of nativeSubscriptions) {
        if (!Expo.isExpoPushToken(sub.token)) {
          console.error(`[NotificationService] Invalid Expo token: ${sub.token}`);
          continue;
        }

        messages.push({
          to: sub.token,
          sound: 'default',
          title: payload.title,
          body: payload.body,
          data: payload.data,
        });
      }

      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        try {
          const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
          results.push({ success: true, type: 'NATIVE', tickets: ticketChunk });
        } catch (error: any) {
          console.error('[NotificationService] Expo Push Error:', error);
          results.push({ success: false, type: 'NATIVE', error: error.message });
        }
      }
    }

    return results;
  }

  /**
   * Alias for sendPushNotification to maintain compatibility with older code.
   */
  async sendNotification(userId: string, payload: any) {
    return this.sendPushNotification(userId, {
      title: payload.title || 'Notification',
      body: payload.message || payload.body || '',
      data: payload.metadata ? { url: payload.metadata.url || '/', type: 'GENERAL' } : undefined
    });
  }

  /**
   * Simple notification method used by several services.
   */
  async notifyUser(userId: string, message: string, urgent: boolean = false) {
    console.log(`[NotificationService] Notifying user ${userId}: ${message}`);
    
    return this.sendPushNotification(userId, {
      title: urgent ? 'Empire Action Required' : 'Empire Update',
      body: message,
      data: { url: '/dashboard', type: urgent ? 'HITL_GATE' : 'GENERAL' }
    });
  }

  /**
   * Save or update a push subscription for a user.
   */
  async subscribeUser(userId: string, subscription: any, type: 'WEB' | 'NATIVE', platform?: string) {
    const token = type === 'WEB' ? subscription.endpoint : subscription.token;
    const existing = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.token, token)).limit(1);

    const values = {
      userId,
      type,
      token,
      authKey: type === 'WEB' ? subscription.keys?.auth : null,
      p256dhKey: type === 'WEB' ? subscription.keys?.p256dh : null,
      platform: platform || 'Desktop'
    };

    if (existing.length > 0) {
      await db.update(pushSubscriptions)
        .set(values)
        .where(eq(pushSubscriptions.token, token));
      return { status: 'updated', id: existing[0].id };
    } else {
      const id = uuidv4();
      await db.insert(pushSubscriptions).values({
        id,
        ...values,
        createdAt: new Date(),
      });
      return { status: 'created', id };
    }
  }
}

export const notificationService = new NotificationService();
