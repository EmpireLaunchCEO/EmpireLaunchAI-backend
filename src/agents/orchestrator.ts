import { StateGraph, END, START } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { etsyService } from "../services/etsyService.js";
import { metaService } from "../services/metaService.js";
import { trendResearchAgent } from "./trendResearchAgent.js";
import { marketIntelligenceAgent } from "./marketIntelligenceAgent.js";
import { contentService } from "../services/contentService.js";
import { notificationService } from "../services/notificationService.js";
import { approvalService } from "../services/approvalService.js";
import { subscriptionGuard } from "../services/subscriptionGuard.js";
import { listingEngine } from "../services/listingEngine.js";
import { roiAnalyticsService } from "../services/roiAnalyticsService.js";

// Define the state of the agent
const OrchestratorState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  nextStep: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "plan",
  }),
  plan: Annotation<string[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  userId: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  context: Annotation<any>({
    reducer: (x, y) => ({ ...x, ...y }),
    default: () => ({}),
  }),
});

// Define the nodes
const planNode = async (state: typeof OrchestratorState.State) => {
  console.log("Planning...");
  
  const plan = ["Research trends", "Analyze market intelligence", "Analyze ROI", "Generate content"];
  
  if (state.context.autoPost && !state.context.approvalRequired) {
    // "Empire Mode" - Add publishing tasks for all generated drafts
    plan.push("Publish to Marketplaces");
  } else {
    plan.push("Request Approval");
  }
  
  return {
    plan,
    nextStep: "execute",
  };
};

const executeNode = async (state: typeof OrchestratorState.State) => {
  console.log("Executing...");
  if (state.plan.length === 0) {
    return { nextStep: "end" };
  }

  const currentTask = state.plan[0];
  console.log(`Executing task: ${currentTask}`);
  
  let updatedContext = {};

  if (currentTask === "Research trends") {
    console.log("Delegating to Trend Research Agent...");
    const goal = state.context.goal || (state.messages.length > 0 ? state.messages[state.messages.length - 1].content.toString() : "");
    const researchResult = await trendResearchAgent.analyzeTrends(goal);
    updatedContext = { research: researchResult };
  } else if (currentTask === "Analyze market intelligence") {
    console.log("Delegating to Market Intelligence Agent...");
    const goal = state.context.goal || (state.messages.length > 0 ? state.messages[state.messages.length - 1].content.toString() : "");
    const brief = await marketIntelligenceAgent.generateProductBrief(goal);
    updatedContext = { marketBrief: brief };
  } else if (currentTask === "Analyze ROI") {
    console.log("Analyzing ROI and generating opportunity cards...");
    const cards = await roiAnalyticsService.generateOpportunityCards(state.userId);
    updatedContext = { opportunityCards: cards };
  } else if (currentTask === "Generate content") {
    console.log("Delegating to Content Service...");
    const goal = state.context.goal || "";
    const researchData = state.context.research || "";
    const marketBrief = state.context.marketBrief || null;
    const drafts = await contentService.generateContent(goal, researchData, marketBrief);
    updatedContext = { drafts: drafts };
  } else if (currentTask === "Request Approval") {
    console.log("Requesting user approval for content drafts...");
    await approvalService.createRequest(
        state.userId, 
        'content', 
        'Review and approve generated content drafts and optimization opportunities', 
        { 
          drafts: state.context.drafts,
          opportunityCards: state.context.opportunityCards 
        }
    );
    await notificationService.notifyUser(state.userId, "Your content drafts are ready for approval.", true);
    // In a real LangGraph setup, we would use an interrupt here.
    // For this prototype, we'll stop the loop.
    return { plan: [], nextStep: "end" };
  } else if (currentTask === "Publish to Marketplaces") {
    console.log("Delegating to Universal Listing Engine...");
    const drafts = state.context.drafts || [];
    for (const draft of drafts) {
      try {
        if (['Etsy', 'Shopify', 'Amazon'].includes(draft.platform)) {
          await listingEngine.publishListing(state.userId, draft.platform, draft);
        } else if (draft.platform === 'Instagram') {
          await metaService.publishPost(state.userId, draft);
        }
      } catch (error) {
        console.error(`Failed to publish to ${draft.platform}:`, error);
      }
    }
  }
  
  const remainingPlan = state.plan.slice(1);
  
  return {
    plan: remainingPlan,
    context: updatedContext,
    nextStep: remainingPlan.length > 0 ? "execute" : "end",
  };
};

// Create the graph
const workflow = new StateGraph(OrchestratorState)
  .addNode("planning", planNode)
  .addNode("execute", executeNode)
  .addEdge(START, "planning")
  .addEdge("planning", "execute")
  .addConditionalEdges("execute", (state) => {
    if (state.nextStep === "end") {
      return END;
    }
    return "execute";
  });

export const orchestrator = workflow.compile();
