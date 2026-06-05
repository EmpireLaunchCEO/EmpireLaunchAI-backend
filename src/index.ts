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
import reviewRoutes from './routes/reviewRoutes.js';
import paypalRoutes from './routes/paypalRoutes.js';
import pushRoutes from './routes/pushRoutes.js';
import empireStudioRoutes from './routes/empireStudioRoutes.js';
import settingsRoutes from './routes/settingsRoutes.js';
import vaultRoutes from './routes/vaultRoutes.js';
import verificationRoutes from './routes/verificationRoutes.js';

import { agentWorker } from './workers/agentWorker.js';
import { schedulerWorker } from './workers/schedulerWorker.js';
import { onboardingWorker } from './workers/onboardingWorker.js';
import { startNeuralBrowserWorker } from './workers/neuralBrowserWorker.js';
import { startDistributionWorker } from './workers/distributionWorker.js';
import { startDnaLabWorker } from './workers/dnaLabWorker.js';
import { startAIWorker } from './services/queueService.js';
import { webSocketService } from './services/websocketService.js';
import { globalRateLimiter } from './middleware/rateLimiter.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const port = parseInt(process.env.PORT || '3000', 10);

// Initialize WebSocket Service
webSocketService.init(httpServer);

if (process.env.NODE_ENV !== 'production') {
  // Start the distributed background worker & AI Queue Worker
  // Note: On serverless platforms like Vercel, these should be moved to separate worker processes
  agentWorker.start();
  schedulerWorker.start();
  startAIWorker();
  startNeuralBrowserWorker();
  startDistributionWorker();
  startDnaLabWorker();
  
  // Note: onboardingWorker starts automatically upon import
  console.log('[Worker] Onboarding Surge Guard & Neural Browser Active');
}

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Bizrunner Scaling-Ready Server is running on port ${port}`);
});

app.use((helmet as any)({
  contentSecurityPolicy: false, // For easier testing with external assets/dashboard
}));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(globalRateLimiter);

// Serve static assets
app.use('/assets', express.static(path.join(process.cwd(), 'public/assets')));

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
app.use('/api/reviews', reviewRoutes);
app.use('/api/paypal', paypalRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/studio', empireStudioRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/vault', vaultRoutes);
app.use('/api/verification', verificationRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', scale: 'ready' });
});

export default app;
/* Wake up Railway */
