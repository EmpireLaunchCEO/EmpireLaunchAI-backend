import { db, schema } from '../db/index.js';
const { notifications } = schema;
import { v4 as uuidv4 } from 'uuid';

export class NotificationService {
  async notifyUser(userId: string, message: string, actionRequired: boolean = false) {
    console.log(`[Notification to User ${userId}]: ${message}`);
    
    await this.sendNotification(userId, {
        type: actionRequired ? 'ACTION_REQUIRED' : 'INFO',
        title: 'System Notification',
        message: message,
        metadata: { actionRequired }
    });
  }

  async sendNotification(userId: string, data: { type: string, title: string, message: string, metadata?: any }) {
    console.log(`[Saving Notification for User ${userId}]: ${data.title}`);
    
    const id = uuidv4();
    await db.insert(notifications).values({
        id,
        userId,
        type: data.type,
        title: data.title,
        message: data.message,
        metadata: data.metadata || {},
        createdAt: new Date()
    });

    // Trigger push notification for mobile users
    await this.sendPushNotification(userId, data.message, data.metadata);
    
    return id;
  }

  async sendPushNotification(userId: string, message: string, data: any) {
    console.log(`[Push Notification to User ${userId}]: ${message}`);
    // In a real implementation:
    // 1. Fetch user's push token from DB
    // 2. Use Firebase Cloud Messaging (FCM) or Expo Push SDK
    // 3. Send the notification
    return true;
  }
}

export const notificationService = new NotificationService();
