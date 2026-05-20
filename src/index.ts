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

dotenv.config();

const app = express();
const httpServer = createServer(app);
const port = parseInt(process.env.PORT || '3000', 10);

app.use(helmet({
  contentSecurityPolicy: false, // For easier testing with external assets/dashboard
}));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Serve static assets
app.use('/assets', express.static(path.join(process.cwd(), 'public/assets')));

app.use('/api/agent', agentRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/approval', approvalRoutes);
app.use('/api/analytics', analyticsRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', scale: 'ready' });
});

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Bizrunner Scaling-Ready Server is running on port ${port}`);
});
