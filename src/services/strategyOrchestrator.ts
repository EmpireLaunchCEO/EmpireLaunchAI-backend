import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { marketIntelligenceService } from './marketIntelligenceService.js';
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { resolveModelForUser, getDefaultModel } from '../utils/resolveModel.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const { goals, tasks, approvals } = schema;

export interface StrategyBlueprint {
  title: string;
  reasoning: string;
  executionGuide: string;
}

export class StrategyOrchestrator {
  private model: BaseChatModel;

  constructor() {
    this.model = getDefaultModel();
  }

  /** Resolve a tier-appropriate model for the given user */
  private async getModel(userId: string): Promise<BaseChatModel> {
    return resolveModelForUser(userId);
  }

  async generateGrowthRoadmap(empireId: string) {
    console.log(`[StrategyOrchestrator] Generating growth roadmap for empire: ${empireId}`);
    
    // 1. Fetch empire/goal details
    const [goal] = await db.select().from(goals).where(eq(goals.id, empireId)).limit(1);
    if (!goal) {
      throw new Error(`Empire (Goal) with ID ${empireId} not found`);
    }

    const niche = goal.title;
    const angle = goal.description;

    // 2. Fetch market data
    const bestSellers = await marketIntelligenceService.fetchEtsyBestSellers(niche);
    const visualTrends = await marketIntelligenceService.fetchVisualTrends(niche);

    // 3. Synthesize with AI
    const template = `
      You are the "Strategic Orchestrator", the high-intelligence brain of the Bizrunner app.
      Your mission is to problem-solve for a business and determine the absolute best order of execution to ensure success.

      Business Niche: {niche}
      Business Angle: {angle}

      Market Intelligence (Etsy Best Sellers):
      {bestSellers}

      Visual Trends:
      {visualTrends}

      Task: Generate a "Growth Roadmap" consisting of 3-5 high-impact "Strategy Blueprints".
      Each blueprint must be a self-contained strategic move that includes:
      1. Title of the strategy.
      2. Step-by-step reasoning (why this move, why now).
      3. Precise execution guide (e.g., "Use Kittl template X", "Target keywords Y", "Post on TikTok at time Z").

      Ensure the order of these blueprints represents the most logical and effective path to scale this empire.
      Be extremely smart and intellectual. Better than ChatGPT—be analytical, precise, and visionary.

      Return ONLY a valid JSON array of objects with keys: title, reasoning, executionGuide.
      Do not include markdown formatting or extra text.
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const activeModel = await this.getModel(goal.userId);
    const chain = RunnableSequence.from([
      prompt,
      activeModel,
      new StringOutputParser(),
    ]);

    const result = await chain.invoke({
      niche,
      angle: angle || "Not specified",
      bestSellers: JSON.stringify(bestSellers),
      visualTrends: JSON.stringify(visualTrends),
    });

    let blueprints: StrategyBlueprint[];
    try {
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      blueprints = JSON.parse(jsonMatch ? jsonMatch[0] : result);
    } catch (e) {
      console.error("[StrategyOrchestrator] Failed to parse AI strategy blueprints:", e);
      blueprints = [
        {
          title: "Initial Market Entry",
          reasoning: "Establish a baseline presence based on niche analysis.",
          executionGuide: `Target ${niche} with minimalist designs and optimized Etsy tags.`
        }
      ];
    }

    // 4. Create tasks in database with 'pending_approval' status
    const createdTasks = [];
    const taskIds = [];
    for (let i = 0; i < blueprints.length; i++) {
      const blueprint = blueprints[i];
      const taskId = uuidv4();
      taskIds.push(taskId);
      
      const [newTask] = await db.insert(tasks).values({
        id: taskId,
        goalId: empireId,
        title: blueprint.title,
        description: blueprint.reasoning,
        priority: blueprints.length - i,
        status: 'pending_approval',
        result: {
          stepByStepGuide: blueprint.executionGuide,
          order: i + 1,
          intelligenceSynthesizedAt: new Date().toISOString()
        },
        createdAt: new Date(),
        updatedAt: new Date()
      }).returning();
      
      createdTasks.push(newTask);
    }

    // 5. Create a record in the 'approvals' table for this roadmap
    const approvalId = uuidv4();
    await db.insert(approvals).values({
      id: approvalId,
      userId: goal.userId,
      type: 'strategic_roadmap',
      payload: {
        empireId,
        taskIds,
        blueprintSummary: blueprints.map(b => b.title).join(', ')
      },
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return { createdTasks, approvalId };
  }

  async getStrategicTasks(empireId: string) {
    return await db.select()
      .from(tasks)
      .where(eq(tasks.goalId, empireId))
      .orderBy(tasks.priority);
  }
}

export const strategyOrchestrator = new StrategyOrchestrator();
