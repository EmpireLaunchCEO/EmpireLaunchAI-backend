const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:xmwLgjOMogoSkIBGofIxAiMEuaNhoPZD@kodama.proxy.rlwy.net:51589/railway' });

const expected = {
  ad_spend: ['id','user_id','platform','amount','currency','campaign_id','date','created_at'],
  approvals: ['id','user_id','task_id','type','payload','status','decision_details','created_at','updated_at'],
  audit_logs: ['id','actor_id','action','target_id','details','ip_address','created_at'],
  blueprints: ['id','user_id','platform','title','description','instructions','assets','created_at','updated_at'],
  campaigns: ['id','user_id','goal_id','name','tone','frequency','status','created_at','updated_at'],
  design_hashes: ['id','platform','external_id','hash','created_at'],
  discovery_results: ['id','user_id','platform','snippet','potential_key_masked','raw_key_encrypted','status','created_at','updated_at'],
  dna_strands: ['id','category','sub_category','embedding','manifest','performance_score','source_platform','external_id','is_global','metadata','created_at'],
  empire_health_logs: ['id','user_id','revenue_velocity','engagement_pulse','operational_consistency','overall_score','timestamp'],
  engagement_metrics: ['id','user_id','platform','external_media_id','view_count','like_count','comment_count','share_count','date','created_at'],
  goals: ['id','user_id','title','description','status','approval_required','auto_post','created_at','updated_at'],
  handle_verifications: ['id','user_id','platform','handle','hash','status','created_at','updated_at'],
  inbox_drafts: ['id','user_id','subject','body','to','type','customer','platform','reasoning','status','created_at','updated_at'],
  infrastructure_costs: ['id','user_id','provider','amount','currency','status','metadata','date','created_at','updated_at'],
  integrations: ['id','user_id','platform','platform_account_id','platform_account_handle','credentials','is_active','created_at','updated_at'],
  niche_dna_repository: ['id','niche','dna_elements','market_gaps','updated_at'],
  notifications: ['id','user_id','type','title','message','metadata','is_read','created_at'],
  oauth_sessions: ['id','user_id','platform','state','code_verifier','used','expires_at','created_at'],
  onboarding_sessions: ['id','user_id','platform','status','current_state','metadata','error','created_at','updated_at'],
  ownership_vault: ['id','user_id','platform','secret_type','encrypted_value','encrypted_dek','iv','tag','last_rotated','created_at'],
  payment_buttons: ['id','user_id','product_id','platform','button_type','button_data','status','created_at','updated_at'],
  payment_links: ['id','product_id','stripe_link_id','url','is_active','created_at','updated_at'],
  products: ['id','user_id','name','description','price','currency','is_ai_generated','external_product_id','created_at','updated_at'],
  push_subscriptions: ['id','user_id','type','token','auth_key','p256dh_key','platform','created_at'],
  revenue_milestones: ['id','user_id','total_revenue','last_milestone_hit','lifetime_surcharges_paid','updated_at'],
  revenue_transactions: ['id','user_id','platform','amount','currency','customer','external_transaction_id','product_id','is_ai_generated','content_id','campaign_id','attribution_source','date','created_at'],
  scheduled_posts: ['id','campaign_id','platform','content','scheduled_at','status','approval_id','created_at','updated_at'],
  style_dna: ['id','user_id','platform','style_dna_profile','is_approved','created_at','updated_at'],
  style_previews: ['id','user_id','niche','dna_strand_ids','primary_vibe','color_scheme','typography_mood','design_personality','synthesis_prompt','mockup_url','performance_score','trend_direction','vibe_tags','difficulty','source_image_discarded','preview_generation_method','metadata','created_at'],
  subscription_logs: ['id','user_id','amount','status','period_start','period_end','type','stripe_invoice_id','created_at'],
  tasks: ['id','goal_id','title','description','status','priority','result','created_at','updated_at'],
  transaction_hashes: ['id','user_id','processed_at'],
  usage_logs: ['id','user_id','type','metadata','created_at'],
  user_settings: ['id','user_id','business_angle','business_niche','theme','language','currency','ai_mode','auto_send_retention','onboarding_complete','linking_complete','notification_modal_dismissed','platform_permissions','connected_platforms','notification_settings','protocol_accepted','is_paid','created_at','updated_at'],
  users: ['id','email','stripe_account_id','paypal_merchant_id','terms_accepted_version','business_slots','tier','is_locked','password_hash','access_key','is_review_mode','mobile_session_token','mobile_session_expires_at','created_at','updated_at']
};

async function audit() {
  const tables = await pool.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  let mismatches = 0;
  for (const t of tables.rows) {
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position", [t.tablename]);
    const dbCols = cols.rows.map(c => c.column_name);
    const expCols = expected[t.tablename] || [];
    
    if (dbCols.length !== expCols.length) {
      const missing = expCols.filter(c => !dbCols.includes(c));
      const extra = dbCols.filter(c => !expCols.includes(c));
      console.log('MISMATCH: ' + t.tablename + ' (DB: ' + dbCols.length + ', Schema: ' + expCols.length + ')');
      if (missing.length) console.log('  Missing columns: ' + missing.join(', '));
      if (extra.length) console.log('  Extra columns: ' + extra.join(', '));
      mismatches++;
    }
  }
  if (mismatches === 0) console.log('ALL TABLES MATCH PERFECTLY');
  else console.log('\nFound ' + mismatches + ' mismatch(es)');
  pool.end();
}
audit().catch(console.error);