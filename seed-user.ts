import { db, schema } from './src/db/index.js';
const { users } = schema;
import dotenv from 'dotenv';
dotenv.config();

async function seedUser() {
  console.log("Seeding test user...");
  try {
    await db.insert(users).values({
      id: 'test-user',
      email: 'test@example.com',
      createdAt: new Date(),
      updatedAt: new Date(),
      termsAcceptedVersion: 1,
      businessSlots: 3,
      isLocked: 0
    }).onConflictDoNothing();
    console.log("Test user seeded successfully.");
  } catch (error) {
    console.error("Error seeding user:", error);
  }
}

seedUser().catch(console.error);
