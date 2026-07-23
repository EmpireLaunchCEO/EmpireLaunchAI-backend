import { pgTable, text, timestamp, uuid, jsonb, boolean, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  stripeAccountId: text('stripe_account_id'),
  paypalMerchantId: text('paypal_merchant_id'),
  termsAcceptedVersion: integer('terms_accepted_version').default(0).notNull(),
  businessSlots: integer('business_slots').default(1).notNull(),
  tier: text('tier').default('STANDARD_USER').notNull(),
  isLocked: boolean('is_locked').default(false).notNull(),
  passwordHash: text('password_hash'),
  accessKey: text('access_key').unique(),
  isReviewMode: boolean('is_review_mode').default(false).notNull(),
  mobileSessionToken: text('mobile_session_token'),
  mobileSessionExpiresAt: timestamp('mobile_session_expires_at'),
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
  isAiGenerated: boolean('is_ai_generated').default(false).notNull(),
  externalProductId: text('external_product_id'), // e.g. Etsy Listing ID
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
  goalId: uuid('goal_id').references(() => goals.id), // Scoped to specific empire
  platform: text('platform').notNull(), // 'etsy', 'fiverr', 'tiktok', 'gmail', etc.
  platformAccountId: text('platform_account_id'), // Indexed for lookups
  platformAccountHandle: text('platform_account_handle'), // For UI display (e.g. @username)
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
  archetype: text('archetype').default('SELLER').notNull(), // 'SELLER', 'CONTENT_CREATOR'
  targetCustomers: text('target_customers'),
  businessGoals: text('business_goals'),
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
  customer: text('customer'),
  externalTransactionId: text('external_transaction_id'),
  productId: uuid('product_id'),
  isAiGenerated: boolean('is_ai_generated').default(false).notNull(),
  contentId: uuid('content_id'), // Reference to scheduled_posts.id
  campaignId: uuid('campaign_id'), // Reference to campaigns.id
  attributionSource: text('attribution_source'), // 'stripe_metadata', 'utm', 'manual'
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

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  type: text('type').default('subscription').notNull(), // 'subscription' | 'expansion'
  stripeSessionId: text('stripe_session_id'),
  amount: integer('amount'),
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
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

/**
 * OAuth Session Store — production-grade PKCE state/verifier persistence.
 * Generated during getAuthUrl and verified/consumed in the callback.
 */
export const oauthSessions = pgTable('oauth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  state: text('state').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  used: boolean('used').default(false).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const dnaStrands = pgTable('dna_strands', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: text('category').notNull(),
  subCategory: text('sub_category'),
  embedding: jsonb('embedding'), // JSON string of float array
  manifest: jsonb('manifest').notNull(), // Logic Manifest JSON
  performanceScore: integer('performance_score').notNull(),
  sourcePlatform: text('source_platform'),
  externalId: text('external_id'),
  isGlobal: boolean('is_global').default(false).notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const inboxDrafts = pgTable('inbox_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  to: text('to').notNull(),
  type: text('type').notNull(), // 'THANK_YOU', 'FOLLOW_UP', 'REVIEW_REQUEST'
  customer: text('customer').notNull(),
  platform: text('platform').notNull(),
  reasoning: text('reasoning'),
  status: text('status').default('pending').notNull(), // 'pending', 'sent', 'rejected'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const infrastructureCosts = pgTable('infrastructure_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  provider: text('provider').notNull(), // 'railway', 'openai', 'gemini'
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  status: text('status').default('active').notNull(), // 'active', 'free_tier', 'limit_reached'
  metadata: jsonb('metadata'), // e.g. usage metrics
  date: timestamp('date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const usageLogs = pgTable('usage_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  type: text('type').notNull(), // 'neural_twin' | 'enhanced_video' | 'faceless'
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auditStatements = pgTable('audit_statements', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  month: integer('month').notNull(), // 1-12
  year: integer('year').notNull(),
  totalRevenue: integer('total_revenue').default(0).notNull(),
  aiAttributedRevenue: integer('ai_attributed_revenue').default(0).notNull(),
  successShareDue: integer('success_share_due').default(0).notNull(),
  lifetimeSurchargesPaid: integer('lifetime_surcharges_paid').default(0).notNull(),
  contentCreated: integer('content_created').default(0).notNull(),
  activeCampaigns: integer('active_campaigns').default(0).notNull(),
  milestoneHit: integer('milestone_hit').default(0).notNull(), // Last $1k milestone
  generatedAt: timestamp('generated_at').defaultNow().notNull(),
});

/**
 * Cinema/Creations — records of AI-generated video, photo, and design assets.
 * Wired to Empire Studio for Operations Base display.
 */
export const creations = pgTable('creations', {
      id: uuid('id').primaryKey().defaultRandom(),
      userId: uuid('user_id').references(() => users.id).notNull(),
      type: text('type').notNull(), // 'facial_dna', 'raw_video', 'enhanced_video', 'neural_twin', 'design'
      title: text('title').default('Untitled'),
      status: text('status').default('processing').notNull(), // 'processing', 'completed', 'failed'
      fileUrl: text('file_url'),
      thumbnailUrl: text('thumbnail_url'),
      metadata: jsonb('metadata'),
      createdAt: timestamp('created_at').defaultNow().notNull(),
      updatedAt: timestamp('updated_at').defaultNow().notNull(),
    });

export const businessSetups = pgTable('business_setups', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  niche: text('niche').notNull(),
  platform: text('platform').notNull(),
  steps: jsonb('steps').notNull(),
  progress: integer('progress').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const masterAssets = pgTable('master_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  campaignId: uuid('campaign_id'),
  styleDna: jsonb('style_dna'),
  styleDnaSource: text('style_dna_source'),
  styleDnaStrandIds: jsonb('style_dna_strand_ids'),
  assetType: text('asset_type').notNull(),
  status: text('status').default('completed').notNull(),
  masterVideoUrl: text('master_video_url'),
  masterImageUrl: text('master_image_url'),
  masterPdfUrl: text('master_pdf_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Library — user's saved design assets, templates, and DNA strands.
 * Integrates with creations, styleDna, and dnaStrands tables.
 */
export const libraryItems = pgTable('library_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type').notNull(), // 'template', 'design', 'dna_strand', 'image', 'video', 'font', 'palette', 'brand_kit'
  category: text('category'),   // e.g. 'social_media', 'logo', 'flyer', 'presentation'
  tags: jsonb('tags'),          // string[] for search/filter
  fileUrl: text('file_url'),
  thumbnailUrl: text('thumbnail_url'),
  sourceCreationId: uuid('source_creation_id'),    // Link to creations table
  sourceDnaStrandId: uuid('source_dna_strand_id'), // Link to dnaStrands table
  sourceStyleDnaId: uuid('source_style_dna_id'),   // Link to styleDna table
  metadata: jsonb('metadata'),
  isFavorite: boolean('is_favorite').default(false).notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
