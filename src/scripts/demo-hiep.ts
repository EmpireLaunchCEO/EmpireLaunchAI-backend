import { v4 as uuidv4 } from 'uuid';
import { executionPipelineService, DynamicExecutionGraph } from '../services/executionPipelineService.js';
import { integrationService } from '../services/integrationService.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { teamDb } from '../db/team-db-client.js';

async function demo() {
  const userId = '00000000-0000-0000-0000-000000000000';
  
  console.log('--- HIEP Phase 1 Demo ---');

  // 1. Ensure user exists
  const existingUser = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(schema.users).values({
      id: userId,
      email: 'demo@empirelaunch.ai',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // 2. Seed mock integrations
  console.log('Seeding mock integrations...');
  await integrationService.saveIntegration(userId, 'etsy', { accessToken: 'mock-etsy-token', shopId: 'mock-shop-123' }, 'mock-shop-123');
  await integrationService.saveIntegration(userId, 'canva', { accessToken: 'mock-canva-token' }, 'mock-canva-user');

  // 3. Define a Strategic Blueprint (DEG)
  const goalId = '11111111-1111-1111-1111-111111111111';
  const node1Id = uuidv4();
  const node2Id = uuidv4();

  // Ensure goal exists in application DB
  const existingGoal = await db.select().from(schema.goals).where(eq(schema.goals.id, goalId)).limit(1);
  if (existingGoal.length === 0) {
    await db.insert(schema.goals).values({
      id: goalId,
      userId,
      title: 'Test Goal',
      description: 'Testing HIEP',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Create mock goal in team-db for visibility
  console.log('Creating mock goal in team-db...');
  try {
    await teamDb.execute(`
      INSERT OR IGNORE INTO goals (id, user_id, title, description, status, created_at, updated_at)
      VALUES ('${goalId}', '${userId}', 'Test Goal', 'Testing HIEP', 'pending', strftime('%s', 'now'), strftime('%s', 'now'))
    `);
  } catch (e) {
    console.warn('Warning: Could not sync goal to team-db');
  }

  // Create tasks in application DB to satisfy foreign key for approvals
  console.log('Creating tasks in application DB...');
  await db.insert(schema.tasks).values([
    {
        id: node1Id,
        goalId,
        title: 'Create Etsy Listing',
        description: 'Create listing for ADHD Digital Planner',
        status: 'todo',
        createdAt: new Date(),
        updatedAt: new Date(),
    },
    {
        id: node2Id,
        goalId,
        title: 'Generate Canva Content',
        description: 'Generate content for ADHD Digital Planner',
        status: 'todo',
        createdAt: new Date(),
        updatedAt: new Date(),
    }
  ]);

  // Create tasks in team-db for visibility
  console.log('Creating tasks in team-db...');
  try {
    await teamDb.execute(`
        INSERT INTO app_tasks (id, goal_id, title, description, status, created_at, updated_at)
        VALUES ('${node1Id}', '${goalId}', 'Create Etsy Listing', 'Create listing for ADHD Digital Planner', 'todo', strftime('%s', 'now'), strftime('%s', 'now'))
    `);
    await teamDb.execute(`
        INSERT INTO app_tasks (id, goal_id, title, description, status, created_at, updated_at)
        VALUES ('${node2Id}', '${goalId}', 'Generate Canva Content', 'Generate content for ADHD Digital Planner', 'todo', strftime('%s', 'now'), strftime('%s', 'now'))
    `);
  } catch (e) {
    console.warn('Warning: Could not sync tasks to team-db');
  }

  const graph: DynamicExecutionGraph = {
    nodes: [
      {
        id: node1Id,
        objective: 'CREATE_ETSY_LISTING',
        parameters: { niche: 'ADHD Digital Planner', price: 1200, shopId: 'mock-shop-123' },
        dependencies: []
      },
      {
        id: node2Id,
        objective: 'GENERATE_CANVA_CONTENT',
        parameters: { niche: 'ADHD Digital Planner', style: 'Pastel Minimalist' },
        dependencies: []
      }
    ]
  };

  // 4. Execute the Pipeline
  console.log('Starting Execution Pipeline...');
  try {
    await executionPipelineService.executeGraph(userId, graph);
    console.log('--- Demo Completed Successfully ---');
  } catch (error) {
    console.error('--- Demo Failed ---', error);
  }

  process.exit(0);
}

demo();
