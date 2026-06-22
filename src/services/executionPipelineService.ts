import { v4 as uuidv4 } from 'uuid';
import { teamDb } from '../db/team-db-client.js';
import { atomicDecomposer, AtomicStep } from './atomicDecomposer.js';
import { etsyService } from './etsyService.js';
import { canvaService } from './canvaService.js';
import { integrationService } from './integrationService.js';
import { notificationService } from './notificationService.js';
import { approvalService } from './approvalService.js';

export interface ExecutionNode {
  id: string;
  objective: string;
  parameters: any;
  dependencies: string[];
}

export interface DynamicExecutionGraph {
  nodes: ExecutionNode[];
}

export class ExecutionPipelineService {
  private MAX_RETRIES = 3;

  async executeGraph(userId: string, graph: DynamicExecutionGraph) {
    console.log(`Executing graph for user ${userId}`);
    
    for (const node of graph.nodes) {
      try {
        await this.executeNode(userId, node);
      } catch (error: any) {
        console.error(`Node ${node.id} failed after self-correction attempts: ${error.message}`);
        // Report to notificationService for 'Strategic Intervention'
        await notificationService.notifyUser(userId, `Critical failure in task ${node.id}: ${error.message}. Manual intervention required.`, true);
      }
    }
  }

  private async executeNode(userId: string, node: ExecutionNode) {
    console.log(`Executing node ${node.id}: ${node.objective}`);
    
    const steps = atomicDecomposer.decompose(node.id, node.objective, node.parameters);
    
    for (const step of steps) {
      await this.createExecutionStep(node.id, step);
    }
    
    const results: Record<string, any> = {};
    for (const step of steps) {
      results[step.objective] = await this.runStepWithSelfCorrection(userId, node.id, step, results);
    }
    
    return results;
  }

  private async runStepWithSelfCorrection(userId: string, taskId: string, step: AtomicStep, previousResults: Record<string, any>): Promise<any> {
    let attempt = 1;
    let lastError = null;

    while (attempt <= this.MAX_RETRIES) {
      try {
        return await this.runStep(userId, taskId, step, previousResults);
      } catch (error: any) {
        lastError = error;
        console.log(`Step ${step.objective} attempt ${attempt} failed. Applying self-correction...`);
        
        const action = attempt < this.MAX_RETRIES ? 'RETRY' : (attempt === this.MAX_RETRIES ? 'PIVOT' : 'ESCALATE');
        
        await this.logSelfCorrection(taskId, step.id, attempt, error.message, action);

        if (action === 'PIVOT') {
          // Attempt to pivot parameters or tool if applicable
          console.log(`Attempting pivot for ${step.objective}...`);
          if (step.objective === 'CANVA_SEARCH_TEMPLATES') {
            step.parameters.style = 'Minimalist'; // Forced pivot to safer style
          }
        }

        attempt++;
        if (attempt > this.MAX_RETRIES) break;
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }

    // Escalation
    console.log(`Escalating step ${step.objective} to user...`);
    await this.logSelfCorrection(taskId, step.id, attempt - 1, lastError.message, 'ESCALATE');
    
    await approvalService.createRequest(
      userId, 
      'TASK_BLOCKER', 
      `Task ${step.objective} failed after multiple attempts.`, 
      { step, error: lastError.message },
      taskId,
      `The system tried to execute ${step.objective} but encountered: ${lastError.message}.`
    );

    throw new Error(`Step ${step.objective} failed after ${this.MAX_RETRIES} attempts: ${lastError.message}`);
  }

  private async logSelfCorrection(taskId: string, stepId: string, attempt: number, error: string, action: string) {
    const id = uuidv4();
    const query = `
      INSERT INTO self_correction_logs (id, task_id, step_id, attempt, error, action_taken, created_at)
      VALUES ('${id}', '${taskId}', '${stepId}', ${attempt}, '${error.replace(/'/g, "''")}', '${action}', strftime('%s', 'now'))
    `;
    await teamDb.execute(query);
  }

  private async createExecutionStep(taskId: string, step: AtomicStep) {
    const id = step.id;
    const query = `
      INSERT INTO execution_steps (id, task_id, step_index, objective, parameters, status, created_at, updated_at)
      VALUES ('${id}', '${taskId}', ${step.stepIndex}, '${step.objective}', '${JSON.stringify(step.parameters)}', 'pending', datetime('now'), datetime('now'))
    `;
    await teamDb.execute(query);
  }

  private async updateExecutionStep(id: string, updates: Partial<{ status: string, result: any, error: string, started_at: string, completed_at: string }>) {
    let setClause = '';
    const keys = Object.keys(updates) as (keyof typeof updates)[];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      let value = updates[key];
      if (typeof value === 'object') value = JSON.stringify(value);
      setClause += `${this.camelToSnake(key)} = '${value}'${i === keys.length - 1 ? '' : ', '}`;
    }
    
    const query = `
      UPDATE execution_steps 
      SET ${setClause}, updated_at = datetime('now')
      WHERE id = '${id}'
    `;
    await teamDb.execute(query);
  }

  private camelToSnake(str: string) {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }

  private async runStep(userId: string, taskId: string, step: AtomicStep, previousResults: Record<string, any>): Promise<any> {
    console.log(`Running atomic step: ${step.objective}`);
    await this.updateExecutionStep(step.id, { status: 'in_progress', started_at: new Date().toISOString() });
    
    try {
      // Resolve parameters (replace {{STEP_NAME.result}} with actual values)
      const resolvedParams = this.resolveParameters(step.parameters, previousResults);
      let result: any;

      switch (step.objective) {
        case 'ETSY_SEARCH_TRENDS':
          result = await etsyService.searchListings(resolvedParams.niche);
          break;
        case 'GENERATE_LISTING_COPY':
          // Mock AI generation
          result = {
            title: `Handmade ${resolvedParams.niche} - Unique Design`,
            description: `Check out this amazing ${resolvedParams.niche}. High quality and sustainable materials used.`
          };
          break;
        case 'ETSY_CREATE_LISTING':
          const etsyCreds = await integrationService.getCredentials(userId, 'etsy');
          result = await etsyService.createListing(etsyCreds.accessToken, etsyCreds.shopId, resolvedParams);
          break;
        case 'CANVA_SEARCH_TEMPLATES':
          result = await canvaService.searchTemplates(userId, resolvedParams.style, resolvedParams.niche);
          break;
        case 'GENERATE_CANVA_DATA':
          // Mock AI content generation for Canva
          result = {
            text_box_1: `Best ${resolvedParams.niche} 2026`,
            price_tag: "$19.99"
          };
          break;
        case 'CANVA_AUTOFILL_DESIGN':
          result = await canvaService.autofillDesign(userId, resolvedParams.templateId, resolvedParams.data);
          break;
        case 'CANVA_EXPORT_DESIGN':
          result = await canvaService.exportDesign(userId, resolvedParams.designId);
          break;
        default:
          throw new Error(`Execution for step ${step.objective} not implemented in API track`);
      }

      await this.updateExecutionStep(step.id, { 
        status: 'completed', 
        result: result, 
        completed_at: new Date().toISOString() 
      });
      return result;
    } catch (error: any) {
      console.error(`Step ${step.objective} failed:`, error);
      await this.updateExecutionStep(step.id, { 
        status: 'failed', 
        error: error.message, 
        completed_at: new Date().toISOString() 
      });
      throw error;
    }
  }

  private resolveParameters(params: any, previousResults: Record<string, any>): any {
    const json = JSON.stringify(params);
    const resolvedJson = json.replace(/\{\{(.*?)\}\}/g, (match, path) => {
      const [objName, ...rest] = path.split('.');
      let val = previousResults[objName];
      for (const key of rest) {
        if (val) val = val[key];
      }
      return val !== undefined ? (typeof val === 'object' ? JSON.stringify(val) : val) : match;
    });
    
    // Clean up potential double-quoted strings if the replacement was already a JSON string
    return JSON.parse(resolvedJson);
  }
}

export const executionPipelineService = new ExecutionPipelineService();
