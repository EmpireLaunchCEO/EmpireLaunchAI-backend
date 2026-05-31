import { StateGraph, END, START } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import axios from "axios";
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { JsonOutputParser } from "@langchain/core/output_parsers";
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
import { canvaService } from "../services/canvaService.js";
import { youtubeService } from "../services/youtubeService.js";
import { tiktokService } from "../services/tiktokService.js";
import { webSocketService } from "../services/websocketService.js";
import { originalityService } from "../services/originalityService.js";
import { assetService } from "../services/assetService.js";
import { hunterGathererService } from "../services/hunterGathererService.js";
import dotenv from "dotenv";

dotenv.config();

const model = new ChatOpenAI({
  modelName: "gpt-4o",
  temperature: 0,
  openAIApiKey: process.env.OPENAI_API_KEY,
});

const AVAILABLE_CAPABILITIES = [
  "Research trends", 
  "Analyze market intelligence", 
  "Analyze ROI", 
  "Generate content",
  "Generate creative assets",
  "Publish to Marketplaces",
  "Request Approval"
];

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
  feedback: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  iterations: Annotation<number>({
    reducer: (x, y) => x + y,
    default: () => 0,
  }),
});

// Define the nodes
const planNode = async (state: typeof OrchestratorState.State) => {
  console.log("Planning dynamically...");
  webSocketService.notifyUser(state.userId, 'ai-log', { message: "Orchestrator: Planning dynamic strategy..." });
  
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY missing, using fallback static plan.");
    webSocketService.notifyUser(state.userId, 'ai-log', { message: "Orchestrator: Using safe fallback plan (OpenAI Key missing)." });
    return {
      plan: [
        "Research trends", 
        "Analyze market intelligence", 
        "Analyze ROI", 
        "Generate content",
        "Generate creative assets",
        state.context.autoPost ? "Publish to Marketplaces" : "Request Approval"
      ],
      nextStep: "critic",
    };
  }

  const goal = state.context.goal || (state.messages.length > 0 ? state.messages[state.messages.length - 1].content.toString() : "Build a business");
  
  const template = `
    You are the Lead Strategist Agent for Bizrunner.
    Your goal is to take a high-level business goal from a user and create a step-by-step execution plan using the available capabilities.

    User Goal: {goal}
    Current Context: {context}
    {feedback_section}

    Available Capabilities:
    {capabilities}

    Rules:
    1. Your output must be a JSON array of tasks.
    2. Each task must be EXACTLY one of the available capabilities.
    3. Order matters. Research should precede generation.
    4. If "autoPost" is true in context, you can include "Publish to Marketplaces".
    5. If "approvalRequired" is true, you MUST include "Request Approval" at the end.
    6. Be efficient but thorough.

    Output format:
    {{
      "plan": ["Capability 1", "Capability 2", ...]
    }}
  `;

  const feedbackSection = state.feedback ? `Previous plan was rejected by the critic. Feedback: ${state.feedback}` : "";

  const prompt = PromptTemplate.fromTemplate(template);
  const chain = RunnableSequence.from([
    prompt,
    model,
    new JsonOutputParser(),
  ]);

  const result = (await chain.invoke({
    goal,
    context: JSON.stringify(state.context),
    capabilities: AVAILABLE_CAPABILITIES.join(", "),
    feedback_section: feedbackSection
  })) as { plan: string[] };

  return {
    plan: result.plan,
    nextStep: "critic",
    iterations: 1
  };
};

const criticNode = async (state: typeof OrchestratorState.State) => {
  console.log("Critiquing plan...");
  webSocketService.notifyUser(state.userId, 'ai-log', { message: "Orchestrator: Critiquing proposed plan for logical consistency..." });
  
  if (!process.env.OPENAI_API_KEY || state.iterations > 3) {
    console.log("Bypassing critic.");
    webSocketService.notifyUser(state.userId, 'ai-log', { message: "Orchestrator: Bypassing critic (Limit reached or Key missing)." });
    return { nextStep: "execute" };
  }

  const goal = state.context.goal || "Build a business";
  
  const template = `
    You are the Strategic Critic for Bizrunner.
    Review the following plan generated for the user's goal.

    User Goal: {goal}
    Proposed Plan: {plan}

    Evaluate if the plan is logically sound, follows the rules (Research -> Analyze -> Generate -> Publish/Approve), and is the most effective way to achieve the goal.
    
    Rules to check:
    1. Research should happen before generation.
    2. Asset generation should happen if content is generated.
    3. Approval must be requested if required.
    
    If the plan is good, respond with "APPROVED" in the decision field.
    If not, respond with "REVISE" and provide constructive feedback.

    Output format:
    {{
      "decision": "APPROVED" | "REVISE",
      "feedback": "string"
    }}
  `;

  const prompt = PromptTemplate.fromTemplate(template);
  const chain = RunnableSequence.from([
    prompt,
    model,
    new JsonOutputParser(),
  ]);

  const result = (await chain.invoke({
    goal,
    plan: JSON.stringify(state.plan),
  })) as { decision: "APPROVED" | "REVISE", feedback: string };

  console.log(`Critic Decision: ${result.decision}`);
  if (result.decision === "APPROVED") {
    return { nextStep: "execute", feedback: "" };
  } else {
    return { nextStep: "planning", feedback: result.feedback };
  }
};

const executeNode = async (state: typeof OrchestratorState.State) => {
  console.log("Executing...");
  if (state.plan.length === 0) {
    return { nextStep: "end" };
  }

  const currentTask = state.plan[0];
  console.log(`Executing task: ${currentTask}`);
  webSocketService.notifyUser(state.userId, 'ai-log', { message: `Orchestrator: Executing task - ${currentTask}...` });
  
  let updatedContext = {};

  if (currentTask === "Research trends") {
    console.log("Delegating to Trend Research Agent...");
    webSocketService.notifyUser(state.userId, 'ai-log', { message: "Trend Agent: Scanning Etsy/TikTok for high-velocity niches..." });
    const goal = state.context.goal || (state.messages.length > 0 ? state.messages[state.messages.length - 1].content.toString() : "");
    const researchResult = await trendResearchAgent.analyzeTrends(goal);
    updatedContext = { research: researchResult };
  } else if (currentTask === "Analyze market intelligence") {
    console.log("Delegating to Market Intelligence Agent...");
    webSocketService.notifyUser(state.userId, 'ai-log', { message: "Intelligence Agent: Drafting product brief based on market research..." });
    const goal = state.context.goal || (state.messages.length > 0 ? state.messages[state.messages.length - 1].content.toString() : "");
    const brief = await marketIntelligenceAgent.generateProductBrief(goal);
    updatedContext = { marketBrief: brief };
  } else if (currentTask === "Analyze ROI") {
    console.log("Analyzing ROI and generating opportunity cards...");
    webSocketService.notifyUser(state.userId, 'ai-log', { message: "ROI Oracle: Projecting financial impact and growth velocity..." });
    const cards = await roiAnalyticsService.generateOpportunityCards(state.userId);
    updatedContext = { opportunityCards: cards };
  } else if (currentTask === "Generate content") {
    console.log("Delegating to Content Service...");
    webSocketService.notifyUser(state.userId, 'ai-log', { message: "Content Agent: Generating social scripts and product copy..." });
    const goal = state.context.goal || "";
    const researchData = state.context.research || "";
    const marketBrief = state.context.marketBrief || null;
    const drafts = await contentService.generateContent(goal, researchData, marketBrief);
    updatedContext = { drafts: drafts };
  } else if (currentTask === "Generate creative assets") {
    console.log("Delegating to Canva Service...");
    webSocketService.notifyUser(state.userId, 'ai-log', { message: "Visual Designer: Selecting Canva templates and autofilling designs..." });
    const marketBrief = state.context.marketBrief || {};
    const style = marketBrief.targetStyle || "Minimalist";
    const niche = marketBrief.niche || "General";
    
    try {
      // 1. Template Selection
      const templateIds: string[] = await canvaService.searchTemplates(state.userId, style, niche);
      const templateId: string = templateIds[0];
      
      // 2. Canva Autofill
      const designId = await canvaService.autofillDesign(state.userId, templateId, {
        title: marketBrief.suggestedTitle || "My Product",
        style: style,
        features: marketBrief.keyFeatures || []
      });
      
      // 3. Canva Export
      const exportUrl = await canvaService.exportDesign(state.userId, designId);

      // 4. Anti-Copycat Validation
      console.log("Running Anti-Copycat validation...");
      webSocketService.notifyUser(state.userId, 'ai-log', { message: "Sentinel: Running Perceptual Hashing to ensure design uniqueness..." });
      const response = await axios.get(exportUrl, { responseType: 'arraybuffer' });
      const imageBuffer = Buffer.from(response.data);

      try {
        await originalityService.validateUniqueness(imageBuffer, niche);
        console.log("Anti-Copycat validation passed.");
        webSocketService.notifyUser(state.userId, 'ai-log', { message: "Sentinel: Design uniqueness verified. No copyright overlap detected." });
      } catch (error: any) {
        console.error("Anti-Copycat validation failed:", error.message);
        webSocketService.notifyUser(state.userId, 'ai-log', { message: `Sentinel Warning: ${error.message}` });
        // In a real scenario, we might trigger a 'Visual Pivot' here.
        // For now, we'll proceed with a warning in the context.
        updatedContext = { ...updatedContext, uniquenessWarning: error.message };
      }

      // 5. Asset Staging
      const stagedAsset = await assetService.stageAsset(exportUrl, state.userId, 'pdf');
      webSocketService.notifyUser(state.userId, 'ai-log', { message: `Orchestrator: Asset staged at ${stagedAsset.url}` });

      updatedContext = {
        ...updatedContext,
        canvaDesignId: designId,
        stagedAssetUrl: stagedAsset.url,
        stagedAssetPath: stagedAsset.path
      };

      console.log(`Creative asset staged at: ${stagedAsset.url}`);
    } catch (error: any) {
      console.error("Failed to generate creative assets via Canva API:", error.message);
      webSocketService.notifyUser(state.userId, 'ai-log', { message: "Orchestrator: Canva API unavailable. Triggering Free Tier Hunter-Gatherer..." });
      
      const harvestingResult = await hunterGathererService.triggerHarvesting(state.userId, {
        platform: 'canva',
        objective: 'DOWNLOAD_ASSET',
        params: { 
            style, 
            niche,
            designId: state.context.canvaDesignId || 'NEW' 
        }
      });

      updatedContext = {
        ...updatedContext,
        harvestingJobId: harvestingResult.jobId,
        harvestingStatus: 'queued'
      };
    }
  } else if (currentTask === "Request Approval") {
    console.log("Requesting user approval for content drafts...");
    webSocketService.notifyUser(state.userId, 'ai-log', { message: "Orchestrator: Pausing for human-in-the-loop approval of drafts..." });
    await approvalService.createRequest(
        state.userId, 
        'content', 
        'Review and approve generated content drafts and optimization opportunities', 
        { 
          drafts: state.context.drafts,
          opportunityCards: state.context.opportunityCards,
          stagedAssetUrl: state.context.stagedAssetUrl 
        }
    );
    await notificationService.notifyUser(state.userId, "Your content drafts are ready for approval.", true);
    // In a real LangGraph setup, we would use an interrupt here.
    // For this prototype, we'll stop the loop.
    return { plan: [], nextStep: "end" };
      } else if (currentTask === "Publish to Marketplaces") {
        console.log("Delegating to Universal Listing Engine...");
        webSocketService.notifyUser(state.userId, 'ai-log', { message: "Listing Engine: Synchronizing product data with Etsy/Meta/Socials..." });
        const drafts = state.context.drafts || [];
        for (const draft of drafts) {
          try {
            if (['Etsy', 'Shopify', 'Amazon'].includes(draft.platform)) {
              webSocketService.notifyUser(state.userId, 'ai-log', { message: `Listing Engine: Creating ${draft.platform} listing for ${draft.title}...` });
              await listingEngine.publishListing(state.userId, draft.platform, draft);
            } else if (draft.platform === 'Instagram' || draft.platform === 'Facebook') {
              webSocketService.notifyUser(state.userId, 'ai-log', { message: `Social Agent: Posting content to ${draft.platform}...` });
              await metaService.publishPost(state.userId, draft);
            } else if (draft.platform === 'TikTok') {
              webSocketService.notifyUser(state.userId, 'ai-log', { message: `Social Agent: Publishing high-velocity video to TikTok...` });
              await tiktokService.publishVideo(state.userId, draft.videoUrl || state.context.stagedAssetUrl, draft.title, draft.caption);
            } else if (draft.platform === 'YouTube') {
              webSocketService.notifyUser(state.userId, 'ai-log', { message: `Social Agent: Publishing Shorts to YouTube...` });
              await youtubeService.publishShorts(state.userId, draft.videoUrl || state.context.stagedAssetUrl, draft.title, draft.caption);
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
  .addNode("critic", criticNode)
  .addNode("execute", executeNode)
  .addEdge(START, "planning")
  .addConditionalEdges("planning", (state) => {
    return "critic";
  })
  .addConditionalEdges("critic", (state) => {
    if (state.nextStep === "execute") {
      return "execute";
    }
    return "planning";
  })
  .addConditionalEdges("execute", (state) => {
    if (state.nextStep === "end") {
      return END;
    }
    return "execute";
  });

export const orchestrator = workflow.compile();
