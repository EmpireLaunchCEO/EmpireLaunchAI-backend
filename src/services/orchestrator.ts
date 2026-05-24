import { db, schema } from '../db/index.js';
import { goals, tasks, approvals, products } from '../db/sqlite-schema.js';
import { eq, and, desc, lt } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { canvaService } from './canvaService.js';
import { etsyService } from './etsyService.js';
import { metaService } from './metaService.js';
import { researchService } from './researchService.js';
import { contentService } from './contentService.js';
import { listingEngine } from './listingEngine.js';
import { campaignService } from './campaignService.js';
import { approvalService } from './approvalService.js';
import { paymentLinkService } from './paymentLinkService.js';
import { originalityService } from './originalityService.js';
import { aiScriptingService } from './aiScriptingService.js';

import { plannerService } from './plannerService.js';
import { neuralMarketDiscoveryService } from './neuralMarketDiscoveryService.js';

export enum EmpireState {
  INITIALIZATION = 'INITIALIZATION',
  NICHE_DISCOVERY = 'NICHE_DISCOVERY',
  STRATEGY_FORMULATION = 'STRATEGY_FORMULATION',
  USER_STRATEGY_APPROVAL = 'USER_STRATEGY_APPROVAL',
  CONTENT_IDEATION = 'CONTENT_IDEATION',
  PRODUCTION_ORCHESTRATION = 'PRODUCTION_ORCHESTRATION',
  DRAFT_LISTING = 'DRAFT_LISTING',
  USER_FINAL_APPROVAL = 'USER_FINAL_APPROVAL',
  DEPLOYMENT = 'DEPLOYMENT',
  GROWTH_MONITORING = 'GROWTH_MONITORING',
  REENGAGEMENT_LOOP = 'REENGAGEMENT_LOOP',
}

export class EmpireOrchestrator {
  /**
   * Main entry point to progress an empire through its lifecycle.
   */
  async runLoop(empireId: string) {
    const [empire] = await db.select().from(goals).where(eq(goals.id, empireId)).limit(1);
    if (!empire) throw new Error(`Empire ${empireId} not found`);

    console.log(`[EmpireOrchestrator] Processing Empire: ${empire.title} | Current State: ${empire.status}`);

    try {
      switch (empire.status) {
        case 'pending':
        case EmpireState.INITIALIZATION:
          await this.handleInitialization(empireId);
          break;
        case EmpireState.NICHE_DISCOVERY:
          await this.handleNicheDiscovery(empireId);
          break;
        case EmpireState.STRATEGY_FORMULATION:
          await this.handleStrategyFormulation(empireId);
          break;
        case EmpireState.USER_STRATEGY_APPROVAL:
          await this.handleUserStrategyApproval(empireId);
          break;
        case EmpireState.CONTENT_IDEATION:
          await this.handleContentIdeation(empireId);
          break;
        case EmpireState.PRODUCTION_ORCHESTRATION:
          await this.handleProductionOrchestration(empireId);
          break;
        case EmpireState.DRAFT_LISTING:
          await this.handleDraftListing(empireId);
          break;
        case EmpireState.USER_FINAL_APPROVAL:
          await this.handleUserFinalApproval(empireId);
          break;
        case EmpireState.DEPLOYMENT:
          await this.handleDeployment(empireId);
          break;
        case EmpireState.GROWTH_MONITORING:
          await this.handleGrowthMonitoring(empireId);
          break;
        case EmpireState.REENGAGEMENT_LOOP:
          await this.handleReengagementLoop(empireId);
          break;
        default:
          console.log(`[EmpireOrchestrator] Empire ${empireId} is in an unknown state: ${empire.status}`);
      }
    } catch (error) {
      console.error(`[EmpireOrchestrator] Error in loop for ${empireId}:`, error);
      // In a real system, we might want to flag the goal as 'failed' or record the error
    }
  }

  private async handleInitialization(empireId: string) {
    console.log(`[EmpireOrchestrator] State: INITIALIZATION -> NICHE_DISCOVERY`);
    await this.updateEmpireStatus(empireId, EmpireState.NICHE_DISCOVERY);
    return this.runLoop(empireId);
  }

  private async handleNicheDiscovery(empireId: string) {
    console.log(`[EmpireOrchestrator] State: NICHE_DISCOVERY`);
    const [empire] = await db.select().from(goals).where(eq(goals.id, empireId)).limit(1);
    
    // 1. Research trends and extract Niche DNA
    const dna = await neuralMarketDiscoveryService.discoverNicheDna(empire.title);
    console.log(`[EmpireOrchestrator] Extracted DNA: ${dna.dnaElements.slice(0, 3).join(', ')}`);
    
    // 2. Transition to Strategy Formulation
    await this.updateEmpireStatus(empireId, EmpireState.STRATEGY_FORMULATION);
    return this.runLoop(empireId);
  }

  private async handleStrategyFormulation(empireId: string) {
    console.log(`[EmpireOrchestrator] State: STRATEGY_FORMULATION`);
    
    // 1. Generate Strategic roadmap using the Reasoning Engine (PlannerService)
    const plan = await plannerService.decomposeGoal(empireId);
    console.log(`[EmpireOrchestrator] Generated DEG with ${plan.taskCount} tasks.`);
    
    // 2. Transition to HITL Approval Gate
    await this.updateEmpireStatus(empireId, EmpireState.USER_STRATEGY_APPROVAL);
  }

  private async handleUserStrategyApproval(empireId: string) {
    console.log(`[EmpireOrchestrator] State: USER_STRATEGY_APPROVAL (Waiting for HITL)`);
    
    // Check if the strategic roadmap approval has been granted
    const [approval] = await db.select()
      .from(approvals)
      .where(and(
        eq(approvals.type, 'strategic_roadmap'),
        eq(approvals.status, 'approved')
      ))
      .orderBy(desc(approvals.createdAt))
      .limit(1);

    if (approval) {
      console.log(`[EmpireOrchestrator] Strategy approved! Moving to CONTENT_IDEATION`);
      await this.updateEmpireStatus(empireId, EmpireState.CONTENT_IDEATION);
      return this.runLoop(empireId);
    }
  }

  private async handleContentIdeation(empireId: string) {
    console.log(`[EmpireOrchestrator] State: CONTENT_IDEATION`);
    
    const [empire] = await db.select().from(goals).where(eq(goals.id, empireId)).limit(1);
    
    // 1. Get the current task to execute
    const tasksToExecute = await db.select()
      .from(tasks)
      .where(eq(tasks.goalId, empireId))
      .orderBy(tasks.priority);
    const currentTask = tasksToExecute.find((t: any) => t.status === 'pending_approval' || t.status === 'todo');

    if (!currentTask) {
      console.log(`[EmpireOrchestrator] No more tasks for empire ${empireId}`);
      await this.updateEmpireStatus(empireId, 'completed');
      return;
    }

    // 2. Generate a Design Blueprint
    const blueprint = await aiScriptingService.generateDesignBlueprint({
      businessNiche: empire.title,
      userGoal: empire.description || '',
      productName: currentTask.title,
      customerInquiry: 'Targeting high-traction keywords'
    });

    // Update task with blueprint
    await db.update(tasks)
      .set({ 
        result: { ...((currentTask.result as any) || {}), designBlueprint: blueprint },
        updatedAt: new Date() 
      })
      .where(eq(tasks.id, currentTask.id));

    await this.updateEmpireStatus(empireId, EmpireState.PRODUCTION_ORCHESTRATION);
    return this.runLoop(empireId);
  }

  private async handleProductionOrchestration(empireId: string) {
    console.log(`[EmpireOrchestrator] State: PRODUCTION_ORCHESTRATION`);
    
    const [empire] = await db.select().from(goals).where(eq(goals.id, empireId)).limit(1);
    const tasksToExecute = await db.select()
      .from(tasks)
      .where(eq(tasks.goalId, empireId))
      .orderBy(tasks.priority);
    const currentTask = tasksToExecute.find((t: any) => t.status === 'pending_approval' || t.status === 'todo');

    if (!currentTask) return;

    // 1. "Free-First" Protocol: Search for free Canva templates
    const templates = await canvaService.searchTemplates(empire.userId, 'minimalist', empire.title);
    const bestTemplate = templates[0];

    // 2. Originality Layer: Anti-Copycat Check
    // In a real flow, we'd have an image buffer from the exported design.
    // For the prototype, we use a mock buffer.
    const mockBuffer = Buffer.from('mock-image-data-' + bestTemplate);
    const result = await originalityService.validateOriginality(mockBuffer, empire.title, empire.userId);
    
    console.log(`[EmpireOrchestrator] Originality Check Passed:`, result);
    console.log(`[EmpireOrchestrator] Selected template: ${bestTemplate}`);
    
    await this.updateEmpireStatus(empireId, EmpireState.DRAFT_LISTING);
    return this.runLoop(empireId);
  }

  private async handleDraftListing(empireId: string) {
    console.log(`[EmpireOrchestrator] State: DRAFT_LISTING`);
    
    const [empire] = await db.select().from(goals).where(eq(goals.id, empireId)).limit(1);
    
    // 1. Research and Draft the listing
    await listingEngine.researchAndDraft(empire.userId, empireId, empire.title);
    
    await this.updateEmpireStatus(empireId, EmpireState.USER_FINAL_APPROVAL);
  }

  private async handleUserFinalApproval(empireId: string) {
    console.log(`[EmpireOrchestrator] State: USER_FINAL_APPROVAL (Waiting for HITL)`);
    
    const [approval] = await db.select()
      .from(approvals)
      .where(and(
        eq(approvals.type, 'content'),
        eq(approvals.status, 'approved')
      ))
      .orderBy(desc(approvals.createdAt))
      .limit(1);

    if (approval) {
      console.log(`[EmpireOrchestrator] Listing approved! Moving to DEPLOYMENT`);
      await this.updateEmpireStatus(empireId, EmpireState.DEPLOYMENT);
      return this.runLoop(empireId);
    }
  }

  private async handleDeployment(empireId: string) {
    console.log(`[EmpireOrchestrator] State: DEPLOYMENT`);
    
    const [empire] = await db.select().from(goals).where(eq(goals.id, empireId)).limit(1);
    
    // 1. Post to Etsy (Approved Listing)
    const [approval] = await db.select()
      .from(approvals)
      .where(and(
        eq(approvals.type, 'content'),
        eq(approvals.status, 'approved')
      ))
      .orderBy(desc(approvals.createdAt))
      .limit(1);

    if (approval) {
       const etsyListing = await listingEngine.publishApprovedListing(empire.userId, approval.id);
       console.log(`[EmpireOrchestrator] Etsy Listing Created: ${etsyListing.listing_id}`);
       
       // 2. Generate Social Commerce Bridge (Payment Link)
       // We mock a product creation based on the task
       const productData = {
         id: uuidv4(),
         userId: empire.userId,
         name: empire.title,
         description: `Premium digital asset for ${empire.title}`,
         price: 2900, // $29.00
         currency: 'usd',
         createdAt: new Date(),
         updatedAt: new Date()
       };
       await db.insert(products).values(productData);

       const bridge = await paymentLinkService.createBridge(empire.userId, productData.id, 'instagram');
       
       // 3. Post to Instagram with Secure Payment Bridge
       await metaService.publishPost(empire.userId, {
         imageUrl: 'https://images.canva.com/placeholder.png',
         caption: `Check out our new ${empire.title}!`,
         paymentUrl: bridge.url,
         productTags: bridge.platformTags
       });
    }

    await this.updateEmpireStatus(empireId, EmpireState.GROWTH_MONITORING);
  }

  private async handleGrowthMonitoring(empireId: string) {
    console.log(`[EmpireOrchestrator] State: GROWTH_MONITORING`);
    // Logic to check sales/views
    // If successful, move to reengagement
    await this.updateEmpireStatus(empireId, EmpireState.REENGAGEMENT_LOOP);
  }

  private async handleReengagementLoop(empireId: string) {
    console.log(`[EmpireOrchestrator] State: REENGAGEMENT_LOOP`);
    // Send thank you emails, etc.
    // Cycle back to CONTENT_IDEATION for the next task
    await this.updateEmpireStatus(empireId, EmpireState.CONTENT_IDEATION);
  }

  private async updateEmpireStatus(id: string, status: string) {
    await db.update(goals)
      .set({ 
        status, 
        updatedAt: new Date()
      })
      .where(eq(goals.id, id));
  }
}

export const empireOrchestrator = new EmpireOrchestrator();
