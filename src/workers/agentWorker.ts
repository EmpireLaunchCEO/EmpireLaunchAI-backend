import cron from 'node-cron';
import { db, schema } from '../db/index.js';
const { goals } = schema;
import { eq } from 'drizzle-orm';
import { aiTaskQueue } from '../services/queueService.js';
import { revenueService } from '../services/revenueService.js';
import { integrationService } from '../services/integrationService.js';

export class AgentWorker {
  constructor() {
    console.log("Agent Worker initialized.");
  }

  start() {
    // Run every hour
    cron.schedule('0 * * * *', async () => {
      console.log("Running scheduled agent loop...");
      await this.processActiveGoals();
      await this.syncAllUserRevenue();
    });

    // Also run immediately on start for testing
    this.processActiveGoals();
    this.syncAllUserRevenue();
  }

  async syncAllUserRevenue() {
    console.log("Syncing revenue for all users...");
    try {
      const allUsers = await db.select().from(schema.users);
      for (const user of allUsers) {
        // In a real implementation, we would fetch fresh transactions from Stripe/Etsy here
        // using integrationService.getCredentials(user.id, 'stripe')
        // For now, we simulate finding new transactions
        const mockTransactions: any[] = []; // This would be populated by API calls
        await revenueService.processNewTransactions(user.id, mockTransactions);
      }
    } catch (error) {
      console.error("Error syncing revenue:", error);
    }
  }

  async processActiveGoals() {
    try {
      // @ts-ignore
      const activeGoals = await db.select().from(goals).where(eq(goals.status, 'active'));
      console.log(`Found ${activeGoals.length} active goals.`);

      for (const goal of activeGoals) {
        console.log(`Queuing goal: ${goal.title} for user: ${goal.userId}`);
        
        try {
          // Push to the distributed task queue
          await aiTaskQueue.add('scheduled-goal-processing', {
            goal: goal.title,
            userId: goal.userId,
            context: {
              goalId: goal.id,
              goal: goal.description || goal.title,
              approvalRequired: goal.approvalRequired,
              autoPost: goal.autoPost
            }
          });
          
          console.log(`Successfully queued processing for goal: ${goal.id}`);
        } catch (error) {
          console.error(`Error queuing goal ${goal.id}:`, error);
        }
      }
    } catch (error) {
      console.error("Error fetching active goals:", error);
    }
  }
}

export const agentWorker = new AgentWorker();
