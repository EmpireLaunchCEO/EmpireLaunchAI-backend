import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  stripeAccountId: text('stripe_account_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  price: integer('price').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const paymentLinks = sqliteTable('payment_links', {
  id: text('id').primaryKey(),
  productId: text('product_id').references(() => products.id).notNull(),
  stripeLinkId: text('stripe_link_id').notNull(),
  url: text('url').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'etsy', 'fiverr', 'tiktok', 'gmail', etc.
  credentials: text('credentials', { mode: 'json' }).notNull(), // Encrypted tokens
  isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('pending').notNull(), // 'pending', 'active', 'completed', 'failed'
  approvalRequired: integer('approval_required', { mode: 'boolean' }).default(true).notNull(),
  autoPost: integer('auto_post', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  goalId: text('goal_id').references(() => goals.id).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('todo').notNull(), // 'todo', 'in_progress', 'completed', 'failed'
  priority: integer('priority').default(0).notNull(),
  result: text('result', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  taskId: text('task_id').references(() => tasks.id),
  type: text('type').notNull(), // 'content', 'financial', 'subscription'
  payload: text('payload', { mode: 'json' }).notNull(), // The data being approved (e.g., draft content, price)
  status: text('status').default('pending').notNull(), // 'pending', 'approved', 'rejected', 'expired'
  decisionDetails: text('decision_details'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const revenueMilestones = sqliteTable('revenue_milestones', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  totalRevenue: integer('total_revenue').default(0).notNull(), // Aggregate sum in cents
  lastMilestoneHit: integer('last_milestone_hit').default(0).notNull(), // Multiple of $1000 in cents
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const transactionHashes = sqliteTable('transaction_hashes', {
  id: text('id').primaryKey(), // The hash of the transaction ID (SHA-256 + salt)
  userId: text('user_id').references(() => users.id).notNull(),
  processedAt: integer('processed_at', { mode: 'timestamp' }).notNull(),
});

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull(), // User ID or Admin ID
  action: text('action').notNull(), // e.g., 'ACCESS_PII', 'DELETE_USER', 'CHANGE_BILLING'
  targetId: text('target_id'), // The ID of the user/resource being acted upon
  details: text('details', { mode: 'json' }), // Metadata
  ipAddress: text('ip_address'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const adSpend = sqliteTable('ad_spend', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'tiktok', 'instagram'
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  campaignId: text('campaign_id'),
  date: integer('date', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const revenueTransactions = sqliteTable('revenue_transactions', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'etsy', 'stripe', 'shopify'
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  externalTransactionId: text('external_transaction_id'),
  productId: text('product_id'),
  date: integer('date', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
