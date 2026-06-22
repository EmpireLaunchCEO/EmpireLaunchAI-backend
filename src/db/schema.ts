import { pgTable, text, timestamp, uuid, jsonb, boolean, integer, real } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  stripeAccountId: text('stripe_account_id'),
  paypalMerchantId: text('paypal_merchant_id'),
  termsAcceptedVersion: integer('terms_accepted_version').default(0).notNull(),
  businessSlots: integer('business_slots').default(1).notNull(),
  isLocked: boolean('is_locked').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  tier: text('tier').default('STANDARD_USER').notNull(),
  accessKey: text('access_key').unique(),
  passwordHash: text('password_hash'),
  isReviewMode: boolean('is_review_mode').default(false).notNull(),
  mobileSessionToken: text('mobile_session_token'),
  mobileSessionExpiresAt: timestamp('mobile_session_expires_at'),
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
  platform: text('platform').notNull(), // 'etsy', 'fiverr', 'tiktok', 'gmail', etc.
  platformAccountId: text('platform_account_id'), // Indexed for lookups
  platformAccountHandle: text('platform_account_handle'), // For UI display
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
  creationDraftId: uuid('creation_draft_id'),
  approvalRequired: boolean('approval_required').default(true).notNull(),
  autoPost: boolean('auto_post').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const tasks = pgTable('app_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id').references(() => goals.id).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('todo').notNull(), // 'pending_approval', 'todo', 'in_progress', 'completed', 'failed'
  creationDraftId: uuid('creation_draft_id'),
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
  payload: jsonb('payload').notNull(), // The data being approved
  status: text('status').default('pending').notNull(), // 'pending', 'approved', 'rejected', 'expired'
  creationDraftId: uuid('creation_draft_id'),
  decisionDetails: text('decision_details'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const revenueMilestones = pgTable('revenue_milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  totalRevenue: integer('total_revenue').default(0).notNull(), // Aggregate sum in cents
  totalAiRevenue: integer('total_ai_revenue').default(0).notNull(),
  lastMilestoneHit: integer('last_milestone_hit').default(0).notNull(), // Multiple of $1000 in cents
  lastAiMilestoneHit: integer('last_ai_milestone_hit').default(0).notNull(),
  lastImminentMilestoneNotified: integer('last_imminent_milestone_notified').default(0).notNull(),
  lifetimeSurchargesPaid: integer('lifetime_surcharges_paid').default(0).notNull(), // Total paid success fees in cents
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const subscriptionLogs = pgTable('subscription_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  amount: integer('amount').notNull(),
  status: text('status').notNull(), // 'paid', 'pending', 'failed'
  creationDraftId: uuid('creation_draft_id'),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  type: text('type').notNull(), // 'subscription', 'surcharge'
  stripeInvoiceId: text('stripe_invoice_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const transactionHashes = pgTable('transaction_hashes', {
  id: text('id').primaryKey(), // The hash of the transaction ID
  userId: uuid('user_id').references(() => users.id).notNull(),
  processedAt: timestamp('processed_at').defaultNow().notNull(),
});

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),
  targetId: text('target_id'),
  details: jsonb('details'),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const adSpend = pgTable('ad_spend', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  campaignId: text('campaign_id'),
  date: timestamp('date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const revenueTransactions = pgTable('revenue_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').default('usd').notNull(),
  customer: text('customer'),
  externalTransactionId: text('external_transaction_id'),
  productId: uuid('product_id'),
  isAiGenerated: boolean('is_ai_generated').default(false).notNull(),
  contentId: uuid('content_id'),
  campaignId: uuid('campaign_id'),
  attributionSource: text('attribution_source'),
  date: timestamp('date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
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
  platform: text('platform').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  instructions: text('instructions').notNull(),
  assets: jsonb('assets').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  goalId: uuid('goal_id').references(() => goals.id),
  name: text('name').notNull(),
  tone: text('tone').notNull(),
  frequency: text('frequency').notNull(),
  status: text('status').default('active').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const scheduledPosts = pgTable('scheduled_posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id).notNull(),
  platform: text('platform').notNull(),
  content: jsonb('content').notNull(),
  scheduledFor: timestamp('scheduled_at').notNull(),
  status: text('status').default('pending').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  approvalId: uuid('approval_id').references(() => approvals.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const designHashes = pgTable('design_hashes', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: text('platform').notNull(),
  externalId: text('external_id'),
  hash: text('hash').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const discoveryResults = pgTable('discovery_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  snippet: text('snippet').notNull(),
  potentialKeyMasked: text('potential_key_masked').notNull(),
  rawKeyEncrypted: text('raw_key_encrypted').notNull(),
  status: text('status').default('pending').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const ownershipVault = pgTable('ownership_vault', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  secretType: text('secret_type').notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  encryptedDek: text('encrypted_dek'),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  lastRotated: timestamp('last_rotated').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const onboardingSessions = pgTable('onboarding_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  status: text('status').default('pending').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  currentState: text('current_state').notNull(),
  metadata: jsonb('metadata'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const paymentButtons = pgTable('payment_buttons', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  productId: uuid('product_id').references(() => products.id).notNull(),
  contentId: uuid('content_id'),
  campaignId: uuid('campaign_id'),
  platform: text('platform').notNull(),
  buttonType: text('button_type').default('link').notNull(),
  buttonData: jsonb('button_data').notNull(),
  status: text('status').default('active').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const reviews = pgTable('reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  marketingApproved: boolean('marketing_approved').default(false).notNull(),
  flaggedForMarketing: boolean('flagged_for_marketing').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const originalityRegistry = pgTable('originality_registry', {
  id: uuid('id').primaryKey().defaultRandom(),
  hash: text('hash').notNull(),
  embedding: jsonb('embedding').notNull(),
  niche: text('niche').notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const accessKeys = pgTable('access_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  tier: text('tier').notNull(),
  isUsed: boolean('is_used').default(false).notNull(),
  usedBy: uuid('used_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const taskPlans = pgTable('task_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id').references(() => goals.id).notNull(),
  dag: jsonb('dag').notNull(),
  status: text('status').default('active').notNull(),
  creationDraftId: uuid('creation_draft_id'),
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

export const taskReasoning = pgTable('task_reasoning', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id).notNull(),
  reasoning: text('reasoning').notNull(),
  predictedRoi: integer('predicted_roi'),
  contextPayload: jsonb('context_payload'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const executionSteps = pgTable('execution_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id).notNull(),
  stepIndex: integer('step_index').notNull(),
  objective: text('objective').notNull(),
  parameters: jsonb('parameters'),
  status: text('status').default('pending').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  result: jsonb('result'),
  error: text('error'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const nicheDnaRepository = pgTable('niche_dna_repository', {
  id: uuid('id').primaryKey().defaultRandom(),
  niche: text('niche').notNull().unique(),
  dnaElements: jsonb('dna_elements').notNull(),
  marketGaps: jsonb('market_gaps'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const selfCorrectionLogs = pgTable('self_correction_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id),
  stepId: uuid('step_id').references(() => executionSteps.id),
  attempt: integer('attempt').notNull(),
  error: text('error').notNull(),
  actionTaken: text('action_taken').notNull(),
  snapshotUrl: text('snapshot_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const historicalPerformance = pgTable('historical_performance', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  date: timestamp('date').notNull(),
  revenue: integer('revenue').notNull(),
  engagement: integer('engagement').notNull(),
  adSpend: integer('ad_spend').notNull(),
  sentimentScore: integer('sentiment_score'),
  platformBreakdown: jsonb('platform_breakdown'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const executionDecisions = pgTable('execution_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  goalId: uuid('goal_id').references(() => goals.id).notNull(),
  decisionType: text('decision_type').notNull(),
  decisionPayload: jsonb('decision_payload').notNull(),
  reasoning: text('reasoning').notNull(),
  wasExecuted: boolean('was_executed').default(false).notNull(),
  outcome: text('outcome'),
  error: text('error'),
  performanceImpact: real('performance_impact'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  executedAt: timestamp('executed_at'),
  completedAt: timestamp('completed_at'),
});

export const marketSignals = pgTable('market_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  niche: text('niche').notNull(),
  platform: text('platform').notNull(),
  signalType: text('signal_type').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  confidence: real('confidence'),
  actionable: boolean('actionable').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const strategySuggestions = pgTable('strategy_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  suggestion: text('suggestion').notNull(),
  reasoning: text('reasoning').notNull(),
  executionDecisionId: uuid('execution_decision_id').references(() => executionDecisions.id),
  platformInsights: jsonb('platform_insights'),
  parameters: jsonb('parameters'),
  status: text('status').default('pending').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  roiImpact: integer('roi_impact'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const handleVerifications = pgTable('handle_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  handle: text('handle').notNull(),
  hash: text('hash').notNull(),
  status: text('status').default('pending').notNull(),
  creationDraftId: uuid('creation_draft_id'),
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

export const dnaStrands = pgTable('dna_strands', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  category: text('category').notNull(),
  subCategory: text('sub_category'),
  embedding: jsonb('embedding'),
  manifest: jsonb('manifest').notNull(),
  performanceScore: integer('performance_score').notNull(),
  sourcePlatform: text('source_platform'),
  externalId: text('external_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
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

export const productionScripts = pgTable('production_scripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').references(() => campaigns.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  title: text('title').notNull(),
  niche: text('niche').notNull(),
  angle: text('angle'),
  strategicReasoning: jsonb('strategic_reasoning').notNull(),
  scenes: jsonb('scenes').notNull(),
  totalDurationSeconds: integer('total_duration_seconds'),
  pacing: text('pacing'),
  backgroundAudioUrl: text('background_audio_url'),
  styleDnaUsed: jsonb('style_dna_used'),
  dnaStrandIds: jsonb('dna_strand_ids'),
  uniquenessHash: text('uniqueness_hash'),
  status: text('status').default('draft').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  renderedAssetUrl: text('rendered_asset_url'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const infrastructureCosts = pgTable('infrastructure_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  provider: text('provider').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').default('usd').notNull(),
  status: text('status').default('active').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  metadata: jsonb('metadata'),
  date: timestamp('date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const emailLogs = pgTable('email_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  customerEmail: text('customer_email').notNull(),
  emailType: text('email_type').notNull(),
  subject: text('subject').notNull(),
  bodyPreview: text('body_preview'),
  status: text('status').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  openCount: integer('open_count').default(0).notNull(),
  clickCount: integer('click_count').default(0).notNull(),
  metadata: jsonb('metadata'),
  openedAt: timestamp('opened_at'),
  clickedAt: timestamp('clicked_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const usageLogs = pgTable('usage_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  type: text('type').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  type: text('type').notNull(),
  token: text('token').notNull(),
  authKey: text('auth_key'),
  p256dhKey: text('p256dh_key'),
  platform: text('platform'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

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

export const creationDrafts = pgTable('creation_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  creationType: text('creation_type').notNull(),
  title: text('title').notNull(),
  content: jsonb('content').notNull(),
  rootId: uuid('root_id'),
  version: integer('version').default(1).notNull(),
  status: text('status').default('pending').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  platform: text('platform'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const creationFeedback = pgTable('creation_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  draftId: uuid('draft_id').references(() => creationDrafts.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  feedback: text('feedback').notNull(),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const dispatchLogs = pgTable('dispatch_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  draftId: uuid('draft_id').references(() => creationDrafts.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  platform: text('platform').notNull(),
  status: text('status').notNull(),
  creationDraftId: uuid('creation_draft_id'),
  externalId: text('external_id'),
  error: text('error'),
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
