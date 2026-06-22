import { db } from '../db/index.js';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { v4 as uuidv4 } from 'uuid';

// Audit Logs Table
export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull(), // User ID or Admin ID
  action: text('action').notNull(), // e.g., 'ACCESS_PII', 'DELETE_USER', 'CHANGE_BILLING'
  targetId: text('target_id'), // The ID of the user/resource being acted upon
  details: text('details', { mode: 'json' }), // Metadata
  ipAddress: text('ip_address'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export class AuditService {
  async log(actorId: string, action: string, targetId?: string, details?: any, ipAddress?: string) {
    console.log(`[AUDIT] Actor: ${actorId}, Action: ${action}, Target: ${targetId}`);
    
    await db.insert(auditLogs).values({
      id: uuidv4(),
      actorId,
      action,
      targetId,
      details,
      ipAddress,
      createdAt: new Date()
    });
  }

  async logPiiAccess(actorId: string, targetUserId: string, field: string, ipAddress?: string) {
    await this.log(actorId, 'ACCESS_PII', targetUserId, { field }, ipAddress);
  }
}

export const auditService = new AuditService();
