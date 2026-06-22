import { db, schema } from './src/db/index.js';
const { users, goals } = schema;

async function seed() {
  console.log('Seeding database...');
  
  const userId = '00000000-0000-0000-0000-000000000000';
  
  // Check if user exists
  const existingUsers = await db.select().from(users);
  if (existingUsers.length === 0) {
    await db.insert(users).values({
      id: userId,
      email: 'test@example.com',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('User created.');
  } else {
    console.log('User already exists.');
  }

  // Add an active goal
  await db.insert(goals).values({
    id: '11111111-1111-1111-1111-111111111111',
    userId: userId,
    title: 'Sell Minimalist Planners',
    description: 'I want to sell digital planners for students with a minimalist aesthetic.',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log('Active goal added.');
  
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
