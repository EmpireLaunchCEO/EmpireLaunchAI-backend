import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import path from 'path';

import agentRoutes from './routes/agentRoutes.js';
import authRoutes from './routes/authRoutes.js';
import stripeRoutes from './routes/stripeRoutes.js';
import mediaRoutes from './routes/mediaRoutes.js';
import emailRoutes from './routes/emailRoutes.js';
import approvalRoutes from './routes/approvalRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';
import socialCommerceRoutes from './routes/socialCommerceRoutes.js';
import campaignRoutes from './routes/campaignRoutes.js';
import webhookRoutes from './routes/webhookRoutes.js';
import blueprintRoutes from './routes/blueprintRoutes.js';
import neuralDiscoveryRoutes from './routes/neuralDiscoveryRoutes.js';
import onboardingRoutes from './routes/onboardingRoutes.js';
import paymentButtonRoutes from './routes/paymentButtonRoutes.js';
import protectedButtonRoutes from './routes/protectedButtonRoutes.js';
import reviewRoutes from './routes/reviewRoutes.js';
import paypalRoutes from './routes/paypalRoutes.js';
import pushRoutes from './routes/pushRoutes.js';
import empireStudioRoutes from './routes/empireStudioRoutes.js';
import studioRoutes from './routes/studioRoutes.js';
import libraryRoutes from './routes/libraryRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import vaultRoutes from './routes/vaultRoutes.js';
import verificationRoutes from './routes/verificationRoutes.js';
import retentionRoutes from './routes/retentionRoutes.js';
import revenueRoutes from './routes/revenueRoutes.js';
import marketDnaRoutes from './routes/marketDnaRoutes.js';
import massDnaRoutes from './routes/massDnaRoutes.js';
import dispatchRoutes from './routes/dispatchRoutes.js';
import integrationRoutes from './routes/integrationRoutes.js';
import mobileRoutes from './routes/mobileRoutes.js';
import auditRoutes from './routes/auditRoutes.js';
import cinemaRoutes from './routes/cinemaRoutes.js';
import setupRoutes from './routes/setupRoutes.js';
import actionRoutes from './routes/actionRoutes.js';

import { agentWorker } from './workers/agentWorker.js';
import { schedulerWorker } from './workers/schedulerWorker.js';
import { onboardingWorker } from './workers/onboardingWorker.js';
import { startNeuralBrowserWorker } from './workers/neuralBrowserWorker.js';
import { startDistributionWorker } from './workers/distributionWorker.js';
import { startDnaLabWorker } from './workers/dnaLabWorker.js';
import { startAIWorker } from './services/queueService.js';
import { webSocketService } from './services/websocketService.js';
import { globalRateLimiter } from './middleware/rateLimiter.js';
import { schedulerService } from './services/schedulerService.js';

import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migrateLibsql } from 'drizzle-orm/libsql/migrator';
import { db } from './db/index.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const port = parseInt(process.env.PORT || '3000', 10);

// Auto-run migrations in production if flagged
if (process.env.RUN_MIGRATIONS === 'true' && !process.env.VERCEL) {
  console.log('[Database] Running migrations...');
  try {
    const isSqlite = process.env.DATABASE_URL?.startsWith('file:') || process.env.DATABASE_URL?.startsWith('libsql:');
    if (isSqlite) {
      console.log(`[Database] Using LibSQL migration folder: ./drizzle`);
      await migrateLibsql(db, { migrationsFolder: './drizzle' });
    } else {
      console.log(`[Database] Using Postgres migration folder: ./drizzle-pg`);
      await migratePg(db, { migrationsFolder: './drizzle-pg' });
    }
    console.log('[Database] Migrations complete.');
  } catch (err) {
    console.error('[Database] Migration failed:', err);
  }
}

// Initialize WebSocket Service
webSocketService.init(httpServer);

if (!process.env.VERCEL) {
  // Start the distributed background worker & AI Queue Worker
  // Note: On serverless platforms like Vercel, these should be moved to separate worker processes
  console.log('[Worker] Activating background workers...');
  agentWorker.start();
  schedulerWorker.start();
  startAIWorker();
  startNeuralBrowserWorker();
  startDistributionWorker();
  startDnaLabWorker();
  
  // Start the weekly Canva gallery DNA harvest scheduler (Playwright-based)
  schedulerService.start();
  
  // Note: onboardingWorker starts automatically upon import
  console.log('[Worker] Onboarding Surge Guard & Neural Browser Active');
}

if (!process.env.VERCEL) {
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Bizrunner Scaling-Ready Server is running on port ${port}`);
  });
}

app.use((helmet as any)({
  contentSecurityPolicy: false, // For easier testing with external assets/dashboard
}));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(globalRateLimiter);

// Serve static assets
app.use('/assets', express.static(path.join(process.cwd(), 'public/assets')));
// Serve rendered video files
app.use('/renders', express.static(path.join(process.cwd(), 'temp', 'renders')));

app.use('/api/agent', agentRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/approval', approvalRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/social-commerce', socialCommerceRoutes);
app.use('/api/campaign', campaignRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/blueprint', blueprintRoutes);
app.use('/api/discovery', neuralDiscoveryRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/payment-buttons', paymentButtonRoutes);
app.use('/protected', protectedButtonRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/paypal', paypalRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/studio', studioRoutes);
app.use('/api/studio', empireStudioRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/retention', retentionRoutes);
app.use('/api/revenue', revenueRoutes);
app.use('/api/market-dna', marketDnaRoutes);
app.use('/api/mass-dna', massDnaRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/mobile', mobileRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/cinema', cinemaRoutes);
app.use('/api/setup', setupRoutes);
app.use('/api/actions', actionRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', scale: 'ready', version: 'v3.1.2_debug_reg_v3' });
});

app.get('/debug-build', (req, res) => {
  res.json({ 
    message: 'Build successful', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    version: 'v3.1.2_debug_reg_v3'
  });
});
app.get('/infra-health-v13', (req, res) => {
  res.json({ status: 'ok', scale: 'ready', version: 'v3.1.2_debug_reg_v3' });
});

// Global Express error handler to prevent crashes
app.use((err: any, req: any, res: any, next: any) => {
  console.error('[GlobalErrorHandler]', err?.message || err);
  res.status(err?.status || 500).json({ error: err?.message || 'Internal server error' });
});

export default app;
/* Tech Troubleshooter Fix - Sat Jun 27 20:45:00 UTC 2026 */
