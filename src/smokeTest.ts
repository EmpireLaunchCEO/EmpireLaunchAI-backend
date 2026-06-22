import dotenv from 'dotenv';
import { HumanMessage } from "@langchain/core/messages";
import fs from 'fs';

dotenv.config();

async function runSmokeTest() {
  console.log("Starting Integrated System Smoke Test...");

  const { approvalService } = await import('./services/approvalService.js');

  // Mock the database-dependent method in approvalService
  approvalService.createRequest = async (userId: string, type: string, description: string, payload: any = {}, taskId?: string) => {
      console.log(`[MOCK] Creating approval request for user ${userId}: ${type}`);
      console.log(`[MOCK] Description: ${description}`);
      return { id: 'mock-approval-id', userId, type, payload, status: 'pending' } as any;
  };

  const { orchestrator } = await import('./agents/orchestrator.js');

  const goal = "I want to sell digital planners for students with a minimalist aesthetic.";
  
  const initialState = {
    messages: [new HumanMessage(goal)],
    userId: "test-user-123",
    context: {
        goal: goal,
        autoPost: false,
        approvalRequired: true
    }
  };

  console.log("Invoking orchestrator...");
  try {
    const result = await orchestrator.invoke(initialState);
    
    console.log("--- Smoke Test Result ---");
    const { messages, ...stateWithoutMessages } = result;
    console.log("Final State (excluding messages):", JSON.stringify(stateWithoutMessages, null, 2));
    
    if (result.context.drafts && result.context.drafts.length > 0) {
      console.log("SUCCESS: Content drafts generated.");
    } else {
      console.error("FAILURE: No content drafts generated.");
    }

    if (result.context.research) {
        console.log("SUCCESS: Trend research performed.");
    } else {
        console.warn("WARNING: No trend research data found in context.");
    }

    if (result.context.marketBrief) {
        console.log("SUCCESS: Market intelligence brief generated.");
    } else {
        console.warn("WARNING: No market intelligence brief found in context.");
    }

    console.log("Smoke Test Completed.");

    // Write result to shared folder for lead verification
    const reportPath = '/home/team/shared/smoke_test_report.json';
    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        goal: goal,
        result: stateWithoutMessages,
        success: !!(result.context.drafts && result.context.drafts.length > 0)
    }, null, 2));
    console.log(`Report written to ${reportPath}`);

  } catch (error) {
    console.error("Smoke Test Failed with error:", error);
  }
}

runSmokeTest();
