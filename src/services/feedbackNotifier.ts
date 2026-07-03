// Feedback notification writer
// Writes feedback submissions to a shared file so the team lead can send email alerts

import { db, schema } from '../db/index.js';
const { reviews } = schema;
import { eq, desc } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NOTIFICATIONS_FILE = path.join(__dirname, '..', '..', '..', '..', 'shared', 'feedback_notifications.json');

function appendNotification(review: any) {
  try {
    const dir = path.dirname(NOTIFICATIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    let notifications: any[] = [];
    if (fs.existsSync(NOTIFICATIONS_FILE)) {
      try {
        notifications = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
      } catch {}
    }
    
    notifications.push({
      id: review.id,
      userId: review.userId,
      rating: review.rating,
      comment: review.comment || '(no comment)',
      createdAt: review.createdAt || new Date().toISOString(),
      notified: false
    });
    
    fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2));
    console.log(`[Feedback Notification] Written to ${NOTIFICATIONS_FILE}`);
  } catch (err) {
    console.error('[Feedback Notification] Error writing notification:', err);
  }
}

export { appendNotification, NOTIFICATIONS_FILE };