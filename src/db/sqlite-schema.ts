import { sqliteTable, text, integer, real, blob } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  stripeAccountId: text('stripe_account_id'),
  paypalMerchantId: text('paypal_merchant_id'),
  termsAcceptedVersion: integer('terms_accepted_version').default(0).notNull(),
  businessSlots: integer('business_slots').default(1).notNull(),
  isLocked: integer('is_locked', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  tier: text('tier').default('STANDARD_USER').notNull(),
  accessKey: text('access_key').unique(),
  passwordHash: text('password_hash'),
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

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  metadata: text('metadata', { mode: 'json' }),
  isRead: integer('is_read', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const integrations = sqliteTable('integrations', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'etsy', 'fiverr', 'tiktok', 'gmail', etc.
  platformAccountId: text('platform_account_id'), // Indexed for lookups (e.g., Etsy shopId)
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

export const tasks = sqliteTable('app_tasks', {
  id: text('id').primaryKey(),
  goalId: text('goal_id').references(() => goals.id).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('todo').notNull(), // 'todo', 'in_progress', 'completed', 'failed'
  creationDraftId: text('creation_draft_id'),
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
  lastImminentMilestoneNotified: integer('last_imminent_milestone_notified').default(0).notNull(), // Multiple of $1000 in cents (triggered at $900)
  lifetimeSurchargesPaid: integer('lifetime_surcharges_paid').default(0).notNull(), // Total paid success fees in cents
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const subscriptionLogs = sqliteTable('subscription_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  amount: integer('amount').notNull(),
  status: text('status').notNull(), // 'paid', 'pending', 'failed'
  periodStart: integer('period_start', { mode: 'timestamp' }).notNull(),
  periodEnd: integer('period_end', { mode: 'timestamp' }).notNull(),
  type: text('type').notNull(), // 'subscription', 'surcharge'
  stripeInvoiceId: text('stripe_invoice_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
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

export const engagementMetrics = sqliteTable('engagement_metrics', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'tiktok', 'instagram', 'youtube'
  externalMediaId: text('external_media_id').notNull(),
  viewCount: integer('view_count').default(0).notNull(),
  likeCount: integer('like_count').default(0).notNull(),
  commentCount: integer('comment_count').default(0).notNull(),
  shareCount: integer('share_count').default(0).notNull(),
  date: integer('date', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const blueprints = sqliteTable('blueprints', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'kittl', 'capcut'
  title: text('title').notNull(),
  description: text('description'),
  instructions: text('instructions').notNull(), // AI-generated guide
  assets: text('assets', { mode: 'json' }).notNull(), // { copy: string[], suggestions: string[] }
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const campaigns = sqliteTable('campaigns', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  goalId: text('goal_id').references(() => goals.id),
  name: text('name').notNull(),
  tone: text('tone').notNull(), // 'professional', 'playful', 'aggressive'
  frequency: text('frequency').notNull(), // 'daily', 'weekly', 'bi-weekly'
  status: text('status').default('active').notNull(), // 'active', 'paused', 'completed'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const scheduledPosts = sqliteTable('scheduled_posts', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id').references(() => campaigns.id).notNull(),
  platform: text('platform').notNull(), // 'instagram', 'tiktok'
  content: text('content', { mode: 'json' }).notNull(), // text, image_urls, etc.
  scheduledFor: integer('scheduled_at', { mode: 'timestamp' }).notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'approved', 'posted', 'failed'
  approvalId: text('approval_id').references(() => approvals.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const designHashes = sqliteTable('design_hashes', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  externalId: text('external_id'), // e.g. best seller product ID
  hash: text('hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const discoveryResults = sqliteTable('discovery_results', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  snippet: text('snippet').notNull(),
  potentialKeyMasked: text('potential_key_masked').notNull(),
  rawKeyEncrypted: text('raw_key_encrypted').notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'approved', 'rejected'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const ownershipVault = sqliteTable('ownership_vault', {
  id: text('id').primaryKey(), // secret_id
  userId: text('user_id').references(() => users.id).notNull(), // tenant_id
  platform: text('platform').notNull(),
  secretType: text('secret_type').notNull(), // 'OAUTH_REFRESH', 'API_KEY', 'BANK_TOKEN'
  encryptedValue: text('encrypted_value').notNull(),
  encryptedDek: text('encrypted_dek'), // For future KMS integration
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  lastRotated: integer('last_rotated', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const onboardingSessions = sqliteTable('onboarding_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'hitl_required', 'in_progress', 'completed', 'failed'
  currentState: text('current_state').notNull(),
  metadata: text('metadata', { mode: 'json' }),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const paymentButtons = sqliteTable('payment_buttons', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  productId: text('product_id').references(() => products.id).notNull(),
  platform: text('platform').notNull(), // 'instagram', 'tiktok', 'facebook', 'general'
  buttonType: text('button_type').default('link').notNull(), // 'link', 'interactive'
  buttonData: text('button_data', { mode: 'json' }).notNull(), // { url: string, label: string }
  status: text('status').default('active').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const reviews = sqliteTable('reviews', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  marketingApproved: integer('marketing_approved', { mode: 'boolean' }).default(false).notNull(),
  flaggedForMarketing: integer('flagged_for_marketing', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const originalityRegistry = sqliteTable('originality_registry', {
  id: text('id').primaryKey(),
  hash: text('hash').notNull(), // dHash
  embedding: text('embedding', { mode: 'json' }).notNull(), // CLIP embedding (float array)
  niche: text('niche').notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const accessKeys = sqliteTable('access_keys', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  tier: text('tier').notNull(),
  isUsed: integer('is_used', { mode: 'boolean' }).default(false).notNull(),
  usedBy: text('used_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const taskPlans = sqliteTable('task_plans', {
  id: text('id').primaryKey(),
  goalId: text('goal_id').references(() => goals.id).notNull(),
  dag: text('dag', { mode: 'json' }).notNull(), // The Directed Acyclic Graph structure
  status: text('status').default('active').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const empireHealthLogs = sqliteTable('empire_health_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  revenueVelocity: integer('revenue_velocity').notNull(),
  engagementPulse: integer('engagement_pulse').notNull(),
  operationalConsistency: integer('operational_consistency').notNull(),
  overallScore: integer('overall_score').notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
});

export const taskReasoning = sqliteTable('task_reasoning', {
  id: text('id').primaryKey(),
  taskId: text('task_id').references(() => tasks.id).notNull(),
  reasoning: text('reasoning').notNull(),
  predictedRoi: integer('predicted_roi'),
  contextPayload: text('context_payload', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const executionSteps = sqliteTable('execution_steps', {
  id: text('id').primaryKey(),
  taskId: text('task_id').references(() => tasks.id).notNull(),
  stepIndex: integer('step_index').notNull(),
  objective: text('objective').notNull(),
  parameters: text('parameters', { mode: 'json' }),
  status: text('status').default('pending').notNull(), // 'pending', 'in_progress', 'completed', 'failed'
  result: text('result', { mode: 'json' }),
  error: text('error'),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const nicheDnaRepository = sqliteTable('niche_dna_repository', {
  id: text('id').primaryKey(),
  niche: text('niche').notNull().unique(),
  dnaElements: text('dna_elements', { mode: 'json' }).notNull(), // ["Minimalist", "Pastel", ...]
  marketGaps: text('market_gaps', { mode: 'json' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const selfCorrectionLogs = sqliteTable('self_correction_logs', {
  id: text('id').primaryKey(),
  taskId: text('task_id').references(() => tasks.id),
  stepId: text('step_id').references(() => executionSteps.id),
  attempt: integer('attempt').notNull(),
  error: text('error').notNull(),
  actionTaken: text('action_taken').notNull(), // 'RETRY', 'PIVOT', 'ESCALATE'
  snapshotUrl: text('snapshot_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const historicalPerformance = sqliteTable('historical_performance', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  date: integer('date', { mode: 'timestamp' }).notNull(),
  revenue: integer('revenue').notNull(), // Aggregate cents
  engagement: integer('engagement').notNull(), // Total reach
  adSpend: integer('ad_spend').notNull(), // Cents
  sentimentScore: integer('sentiment_score'), // 0-100
  platformBreakdown: text('platform_breakdown', { mode: 'json' }), // { etsy: cents, tiktok: views, etc. }
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const executionDecisions = sqliteTable('execution_decisions', {
      id: text('id').primaryKey(),
      goalId: text('goal_id').references(() => goals.id).notNull(),
      decisionType: text('decision_type').notNull(), // 'RESEARCH', 'CREATE_CONTENT', 'DRAFT_LISTING', 'SCHEDULE_POST', 'MONITOR_PERFORMANCE', 'OPTIMIZE_STRATEGY', 'WAIT_FOR_APPROVAL', 'SELF_CORRECT', 'NOTIFY_USER', 'NO_ACTION'
      decisionPayload: text('decision_payload', { mode: 'json' }).notNull(), // JSON — the actual decision data
      reasoning: text('reasoning').notNull(), // AI's reasoning for making this decision
      wasExecuted: integer('was_executed', { mode: 'boolean' }).default(false).notNull(),
      outcome: text('outcome'), // 'success', 'partial', 'failed'
      error: text('error'),
      performanceImpact: real('performance_impact'), // Numeric impact on goal progress
      createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
      executedAt: integer('executed_at', { mode: 'timestamp' }),
      completedAt: integer('completed_at', { mode: 'timestamp' }),
    });

export const marketSignals = sqliteTable('market_signals', {
      id: text('id').primaryKey(),
      niche: text('niche').notNull(),
      platform: text('platform').notNull(),
      signalType: text('signal_type').notNull(), // 'trend', 'price_shift', 'new_competitor', 'viral_format'
      title: text('title').notNull(),
      description: text('description'),
      confidence: real('confidence'), // 0.0 - 1.0
      actionable: integer('actionable', { mode: 'boolean' }).default(false).notNull(),
      createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    });

export const strategySuggestions = sqliteTable('strategy_suggestions', {
      id: text('id').primaryKey(),
      userId: text('user_id').references(() => users.id).notNull(),
      type: text('type').notNull(), // 'TREND_PIVOT', 'SEO_OPTIMIZATION', 'AD_BOOST'
      title: text('title').notNull(),
      suggestion: text('suggestion').notNull(), // Markdown body
      reasoning: text('reasoning').notNull(), // "The Revenue Oracle found..."
      executionDecisionId: text('execution_decision_id').references(() => executionDecisions.id),
      platformInsights: text('platform_insights', { mode: 'json' }), // JSON — platform-specific trend/insight data
      parameters: text('parameters', { mode: 'json' }), // Atomic execution steps
      status: text('status').default('pending').notNull(), // 'pending', 'approved', 'dismissed', 'executed'
      roiImpact: integer('roi_impact'), // Estimated profit increase in cents
      createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    });

export const handleVerifications = sqliteTable('handle_verifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(), // 'tiktok', 'instagram'
  handle: text('handle').notNull(),
  hash: text('hash').notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'verified', 'failed'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const styleDna = sqliteTable('style_dna', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  styleDnaProfile: text('style_dna_profile', { mode: 'json' }).notNull(),
  isApproved: integer('is_approved', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const dnaStrands = sqliteTable('dna_strands', {
  id: text('id').primaryKey(),
  category: text('category').notNull(),
  subCategory: text('sub_category'),
  embedding: text('embedding'), // JSON string of float array
  manifest: text('manifest').notNull(), // Logic Manifest JSON
  performanceScore: integer('performance_score').notNull(),
  sourcePlatform: text('source_platform'),
  externalId: text('external_id'),
  metadata: text('metadata'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const stylePreviews = sqliteTable('style_previews', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  niche: text('niche').notNull(),
  dnaStrandIds: text('dna_strand_ids', { mode: 'json' }).notNull(),
  primaryVibe: text('primary_vibe').notNull(),
  colorScheme: text('color_scheme').notNull(),
  typographyMood: text('typography_mood').notNull(),
  designPersonality: text('design_personality').notNull(),
  synthesisPrompt: text('synthesis_prompt').notNull(),
  mockupUrl: text('mockup_url'),
  performanceScore: integer('performance_score').default(0).notNull(),
  trendDirection: text('trend_direction').default('stable').notNull(),
  vibeTags: text('vibe_tags', { mode: 'json' }).notNull(),
  difficulty: text('difficulty').default('instant').notNull(),
  sourceImageDiscarded: integer('source_image_discarded', { mode: 'boolean' }).default(true).notNull(),
  previewGenerationMethod: text('preview_generation_method').notNull(),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const userSettings = sqliteTable('user_settings', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull().unique(),
  businessAngle: text('business_angle'),
  businessNiche: text('business_niche'),
  theme: text('theme').default('light').notNull(),
  language: text('language').default('en').notNull(),
  currency: text('currency').default('USD').notNull(),
  aiMode: text('ai_mode').default('co-pilot').notNull(),
  autoSendRetention: integer('auto_send_retention', { mode: 'boolean' }).default(false).notNull(),
  onboardingComplete: integer('onboarding_complete', { mode: 'boolean' }).default(false).notNull(),
  linkingComplete: integer('linking_complete', { mode: 'boolean' }).default(false).notNull(),
  notificationModalDismissed: integer('notification_modal_dismissed', { mode: 'boolean' }).default(false).notNull(),
  platformPermissions: text('platform_permissions', { mode: 'json' }),
  connectedPlatforms: text('connected_platforms', { mode: 'json' }),
  notificationSettings: text('notification_settings', { mode: 'json' }),
  protocolAccepted: integer('protocol_accepted', { mode: 'boolean' }).default(false).notNull(),
  isPaid: integer('is_paid', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const productionScripts = sqliteTable('production_scripts', {
  id: text('id').primaryKey(),
  campaignId: text('campaign_id').references(() => campaigns.id).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  title: text('title').notNull(),
  niche: text('niche').notNull(),
  angle: text('angle'),
  strategicReasoning: text('strategic_reasoning', { mode: 'json' }).notNull(),
  scenes: text('scenes', { mode: 'json' }).notNull(),
  totalDurationSeconds: integer('total_duration_seconds'),
  pacing: text('pacing'),
  backgroundAudioUrl: text('background_audio_url'),
  styleDnaUsed: text('style_dna_used', { mode: 'json' }),
  dnaStrandIds: text('dna_strand_ids', { mode: 'json' }),
  uniquenessHash: text('uniqueness_hash'),
  status: text('status').default('draft').notNull(),
  renderedAssetUrl: text('rendered_asset_url'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const infrastructureCosts = sqliteTable('infrastructure_costs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  provider: text('provider').notNull(), // 'railway', 'openai', 'gemini'
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  status: text('status').default('active').notNull(), // 'active', 'free_tier', 'limit_reached'
  metadata: text('metadata', { mode: 'json' }), // e.g. usage metrics
  date: integer('date', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const emailLogs = sqliteTable('email_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  customerEmail: text('customer_email').notNull(),
  emailType: text('email_type').notNull(), // 'thank_you', 'review_request'
  subject: text('subject').notNull(),
  bodyPreview: text('body_preview'),
  status: text('status').notNull(), // 'sent', 'opened', 'clicked'
  openCount: integer('open_count').default(0).notNull(),
  clickCount: integer('click_count').default(0).notNull(),
  metadata: text('metadata', { mode: 'json' }),
  openedAt: integer('opened_at', { mode: 'timestamp' }),
  clickedAt: integer('clicked_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const usageLogs = sqliteTable('usage_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  type: text('type').notNull(), // 'neural_twin' | 'enhanced_video' | 'faceless'
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const creationDrafts = sqliteTable('creation_drafts', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => users.id).notNull(),
  campaignId: text('campaign_id').references(() => campaigns.id),
  creationType: text('creation_type').notNull(), // 'video', 'design', 'faceless', 'copy'
  title: text('title').notNull(),
  content: text('content', { mode: 'json' }).notNull(), // Asset URLs, copy, etc.
  rootId: text("root_id"),
  version: integer('version').default(1).notNull(),
  status: text('status').default('pending').notNull(), // 'pending', 'approved', 'rejected', 'dispatched'
  platform: text('platform'), // 'tiktok', 'instagram', 'etsy', etc.
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const creationFeedback = sqliteTable('creation_feedback', {
  id: text('id').primaryKey(),
  draftId: text('draft_id').references(() => creationDrafts.id).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  feedback: text('feedback').notNull(),
  actor: text('actor').notNull(), // 'user', 'ai'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const dispatchLogs = sqliteTable('dispatch_logs', {
  id: text('id').primaryKey(),
  draftId: text('draft_id').references(() => creationDrafts.id).notNull(),
  userId: text('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  status: text('status').notNull(), // 'success', 'failed'
  externalId: text('external_id'), // Platform's post/listing ID
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
