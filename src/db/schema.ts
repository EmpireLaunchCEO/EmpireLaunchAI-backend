import { pgTable, text, timestamp, uuid, jsonb, boolean, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  stripeAccountId: text('stripe_account_id'),
  termsAcceptedVersion: integer('terms_accepted_version').default(0).notNull(),
  businessSlots: integer('business_slots').default(3).notNull(),
  isLocked: boolean('is_locked').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  price: integer('price').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const paymentLinks = pgTable('payment_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').references(() => products.id).notNull(),
  stripeLinkId: text('stripe_link_id').notNull(),
  url: text('url').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  metadata: jsonb('metadata'),
  isRead: boolean('is_read').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'etsy', 'fiverr', 'tiktok', 'gmail', etc.
  platformAccountId: text('platform_account_id'), // Indexed for lookups
  credentials: jsonb('credentials').notNull(), // Encrypted tokens
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const goals = pgTable('goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('pending').notNull(), // 'pending', 'active', 'completed', 'failed'
  approvalRequired: boolean('approval_required').default(true).notNull(),
  autoPost: boolean('auto_post').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id').references(() => goals.id).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('todo').notNull(), // 'pending_approval', 'todo', 'in_progress', 'completed', 'failed'
  priority: integer('priority').default(0).notNull(),
  result: jsonb('result'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  taskId: uuid('task_id').references(() => tasks.id),
  type: text('type').notNull(), // 'content', 'financial', 'subscription'
  payload: jsonb('payload').notNull(), // The data being approved (e.g., draft content, price)
  status: text('status').default('pending').notNull(), // 'pending', 'approved', 'rejected', 'expired'
  decisionDetails: text('decision_details'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const revenueMilestones = pgTable('revenue_milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  totalRevenue: integer('total_revenue').default(0).notNull(), // Aggregate sum in cents
  lastMilestoneHit: integer('last_milestone_hit').default(0).notNull(), // Multiple of $1000 in cents
  lifetimeSurchargesPaid: integer('lifetime_surcharges_paid').default(0).notNull(), // Total paid success fees in cents
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const subscriptionLogs = pgTable('subscription_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  amount: integer('amount').notNull(),
  status: text('status').notNull(), // 'paid', 'pending', 'failed'
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  type: text('type').notNull(), // 'subscription', 'surcharge'
  stripeInvoiceId: text('stripe_invoice_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const transactionHashes = pgTable('transaction_hashes', {
  id: text('id').primaryKey(), // The hash of the transaction ID (SHA-256 + salt)
  userId: uuid('user_id').references(() => users.id).notNull(),
  processedAt: timestamp('processed_at').defaultNow().notNull(),
});

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: text('actor_id').notNull(), // User ID or Admin ID
  action: text('action').notNull(), // e.g., 'ACCESS_PII', 'DELETE_USER', 'CHANGE_BILLING'
  targetId: text('target_id'), // The ID of the user/resource being acted upon
  details: jsonb('details'), // Metadata
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const adSpend = pgTable('ad_spend', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'tiktok', 'instagram'
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  campaignId: text('campaign_id'),
  date: timestamp('date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const revenueTransactions = pgTable('revenue_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'etsy', 'stripe', 'shopify'
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  externalTransactionId: text('external_transaction_id'),
  productId: uuid('product_id'),
  date: timestamp('date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  });

  export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  goalId: uuid('goal_id').references(() => goals.id),
  name: text('name').notNull(),
  tone: text('tone').notNull(), // 'professional', 'playful', 'aggressive'
  frequency: text('frequency').notNull(), // 'daily', 'weekly', 'bi-weekly'
  status: text('status').default('active').notNull(), // 'active', 'paused', 'completed'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  });

export const engagementMetrics = pgTable('engagement_metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  externalMediaId: text('external_media_id').notNull(),
  viewCount: integer('view_count').default(0).notNull(),
  likeCount: integer('like_count').default(0).notNull(),
  commentCount: integer('comment_count').default(0).notNull(),
  shareCount: integer('share_count').default(0).notNull(),
  date: timestamp('date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const blueprints = pgTable('blueprints', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'kittl', 'capcut'
  title: text('title').notNull(),
  description: text('description'),
  instructions: text('instructions').notNull(), // AI-generated guide
  assets: jsonb('assets').notNull(), // { copy: string[], suggestions: string[] }
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  });

  export const discoveryResults = pgTable('discovery_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  snippet: text('snippet').notNull(),
  potentialKeyMasked: text('potential_key_masked').notNull(),
  rawKeyEncrypted: text('raw_key_encrypted').notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'approved', 'rejected'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  });

  export const ownershipVault = pgTable('ownership_vault', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  secretType: text('secret_type').notNull(), // 'OAUTH_REFRESH', 'API_KEY', 'BANK_TOKEN'
  encryptedValue: text('encrypted_value').notNull(),
  encryptedDek: text('encrypted_dek'),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  lastRotated: timestamp('last_rotated').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  });

  export const designHashes = pgTable('design_hashes', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: text('platform').notNull(),
  externalId: text('external_id'), // e.g. best seller product ID
  hash: text('hash').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

  export const scheduledPosts = pgTable('scheduled_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id).notNull(),
  platform: text('platform').notNull(), // 'instagram', 'tiktok'
  content: jsonb('content').notNull(), // text, image_urls, etc.
  scheduledFor: timestamp('scheduled_at').notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'approved', 'posted', 'failed'
  approvalId: uuid('approval_id').references(() => approvals.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  });

export const onboardingSessions = pgTable('onboarding_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'hitl_required', 'in_progress', 'completed', 'failed'
  currentState: text('current_state').notNull(), // e.g. 'START', 'LOGIN_DETECTED', 'FILLING_PROFILE'
  metadata: jsonb('metadata'), // Browser session info, etc.
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const paymentButtons = pgTable('payment_buttons', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  productId: uuid('product_id').references(() => products.id).notNull(),
  platform: text('platform').notNull(), // 'instagram', 'tiktok', 'facebook', 'general'
  buttonType: text('button_type').default('link').notNull(), // 'link', 'interactive'
  buttonData: jsonb('button_data').notNull(), // { url: string, label: string }
  status: text('status').default('active').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  type: text('type').notNull(), // 'WEB' or 'NATIVE'
  token: text('token').notNull(), // Expo token or Web endpoint
  authKey: text('auth_key'),
  p256dhKey: text('p256dh_key'),
  platform: text('platform'), // 'iOS', 'Android', 'Desktop'
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const handleVerifications = pgTable('handle_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'tiktok', 'instagram'
  handle: text('handle').notNull(),
  hash: text('hash').notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'verified', 'failed'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const styleDna = pgTable('style_dna', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  styleDnaProfile: jsonb('style_dna_profile').notNull(),
  isApproved: boolean('is_approved').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const empireHealthLogs = pgTable('empire_health_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  revenueVelocity: integer('revenue_velocity').notNull(),
  engagementPulse: integer('engagement_pulse').notNull(),
  operationalConsistency: integer('operational_consistency').notNull(),
  overallScore: integer('overall_score').notNull(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
});

export const nicheDnaRepository = pgTable('niche_dna_repository', {
  id: uuid('id').primaryKey().defaultRandom(),
  niche: text('niche').notNull().unique(),
  dnaElements: jsonb('dna_elements').notNull(),
  marketGaps: jsonb('market_gaps').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const stylePreviews = pgTable('style_previews', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  niche: text('niche').notNull(),
  dnaStrandIds: jsonb('dna_strand_ids').notNull(),
  primaryVibe: text('primary_vibe').notNull(),
  colorScheme: text('color_scheme').notNull(),
  typographyMood: text('typography_mood').notNull(),
  designPersonality: text('design_personality').notNull(),
  synthesisPrompt: text('synthesis_prompt').notNull(),
  mockupUrl: text('mockup_url'),
  performanceScore: integer('performance_score').default(0).notNull(),
  trendDirection: text('trend_direction').default('stable').notNull(),
  vibeTags: jsonb('vibe_tags').notNull(),
  difficulty: text('difficulty').default('instant').notNull(),
  sourceImageDiscarded: boolean('source_image_discarded').default(true).notNull(),
  previewGenerationMethod: text('preview_generation_method').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull().unique(),
  businessAngle: text('business_angle'),
  businessNiche: text('business_niche'),
  theme: text('theme').default('light').notNull(),
  language: text('language').default('en').notNull(),
  currency: text('currency').default('USD').notNull(),
  aiMode: text('ai_mode').default('co-pilot').notNull(),
  autoSendRetention: boolean('auto_send_retention').default(false).notNull(),
  onboardingComplete: boolean('onboarding_complete').default(false).notNull(),
  linkingComplete: boolean('linking_complete').default(false).notNull(),
  notificationModalDismissed: boolean('notification_modal_dismissed').default(false).notNull(),
  platformPermissions: jsonb('platform_permissions'),
  connectedPlatforms: jsonb('connected_platforms'),
  notificationSettings: jsonb('notification_settings'),
  protocolAccepted: boolean('protocol_accepted').default(false).notNull(),
  isPaid: boolean('is_paid').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
