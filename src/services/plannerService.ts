import { db, schema } from '../db/index.js';
const { goals, taskPlans, tasks, taskReasoning } = schema;
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { resolveStudioReasoner } from "../utils/resolveModel.js";
import dotenv from 'dotenv';

dotenv.config();

export class PlannerService {
  constructor() {}

  /**
   * Decomposes a high-level goal into a Dynamic Execution Graph (DEG).
   */
  async decomposeGoal(goalId: string) {
    const [goal] = await db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    if (!goal) throw new Error(`Goal ${goalId} not found`);

    console.log(`[PlannerService] Decomposing goal into DEG: ${goal.title}`);

    const model = await resolveStudioReasoner();

    const template = `
      You are the "Strategic Intellect" Planner for EmpireLaunchAI.
      Your task is to decompose a high-level business goal into a Directed Acyclic Graph (DAG) of precise execution steps.
      
      Goal: {title}
      Description: {description}
      
      Categories:
      - Discovery: Market research, trend extraction, competitor analysis.
      - Creative: Design blueprints, asset generation (Canva/Kittl), video scripting (CapCut).
      - Marketing: Social media posting (TikTok/Instagram), ad copy, engagement strategy.
      - Sales: Product listing (Etsy/Shopify), pricing strategy, direct-to-bank payment setup.

      Rules:
      1. Break down the goal into atomic execution tasks.
      2. Each task must have a unique internal ID (e.g., "TASK_1").
      3. Define dependencies clearly (e.g., "TASK_3" depends on "TASK_1").
      4. Estimate Predicted ROI (1-100) for each task based on impact.
      5. Provide deep "Strategic Reasoning" for every task (better than ChatGPT).
      6. Output MUST be a valid JSON object.

      JSON Format:
      {{
        "tasks": [
          {{
            "id": "string",
            "title": "string",
            "description": "string",
            "category": "Discovery" | "Creative" | "Marketing" | "Sales",
            "dependencies": ["string"],
            "predictedRoi": number,
            "reasoning": "string"
          }}
        ]
      }}
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      model,
      new JsonOutputParser(),
    ]);

    try {
      const result = await chain.invoke({
        title: goal.title,
        description: goal.description || "Scale this niche effectively.",
      }) as any;

      const dagId = uuidv4();
      await db.insert(taskPlans).values({
        id: dagId,
        goalId,
        dag: result,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create tasks in the 'tasks' table and link reasoning
      for (const taskData of result.tasks) {
        const taskId = uuidv4();
        await db.insert(tasks).values({
          id: taskId,
          goalId,
          title: taskData.title,
          description: taskData.description,
          status: 'todo',
          priority: taskData.predictedRoi,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await db.insert(taskReasoning).values({
          id: uuidv4(),
          taskId,
          reasoning: taskData.reasoning,
          predictedRoi: taskData.predictedRoi,
          contextPayload: { 
            category: taskData.category, 
            dependencies: taskData.dependencies, 
            internalId: taskData.id 
          },
          createdAt: new Date(),
        });
      }

      return { dagId, taskCount: result.tasks.length };
    } catch (error: any) {
      console.error("[PlannerService] Decomposition failed:", error.message);
      throw error;
    }
  }
}

export const plannerService = new PlannerService();
