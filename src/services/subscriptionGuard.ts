import { approvalService } from './approvalService.js';

export class SubscriptionGuard {
  async canExecuteFinancialAction(userId: string, type: 'subscription' | 'financial', taskId: string, expectedPayload: any): Promise<boolean> {
    console.log(`SubscriptionGuard: Checking permission for user ${userId}, task ${taskId}`);
    
    const approval = await approvalService.getValidApproval(userId, type, taskId);
    
    if (!approval) {
      console.warn(`SubscriptionGuard: No approved request found for task ${taskId}`);
      return false;
    }

    // Basic payload verification (can be more complex with signatures)
    const payloadMatch = JSON.stringify(approval.payload) === JSON.stringify(expectedPayload);
    
    if (!payloadMatch) {
      console.error(`SubscriptionGuard: Payload mismatch for task ${taskId}`);
      return false;
    }

    return true;
  }
}

export const subscriptionGuard = new SubscriptionGuard();
