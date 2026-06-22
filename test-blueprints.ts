import { blueprintService } from './src/services/blueprintService.js';
import dotenv from 'dotenv';
dotenv.config();

async function testBlueprints() {
  const TEST_USER_ID = '00000000-0000-0000-0000-000000000000';
  console.log("--- Testing Kittl Blueprint (Normal) ---");
  const kittl = await blueprintService.generateKittlBlueprint({
    userId: TEST_USER_ID,
    platform: 'kittl',
    niche: 'Vintage T-Shirts',
    productTitle: 'Retro Mountain Design',
    targetAudience: 'Outdoor enthusiasts'
  });
  console.log("Kittl Instructions length:", kittl.instructions.length);

  console.log("\n--- Testing Kittl Blueprint (Empire Mode) ---");
  const kittlEmpire = await blueprintService.generateKittlBlueprint({
    userId: TEST_USER_ID,
    platform: 'kittl',
    niche: 'Vintage T-Shirts',
    productTitle: 'Retro Mountain Design',
    targetAudience: 'Outdoor enthusiasts',
    isEmpireMode: true
  });
  console.log("Kittl Empire Instructions length:", kittlEmpire.instructions.length);
  if (kittlEmpire.instructions.includes("Empire Mode")) {
    console.log("Empire Mode Warning detected (as expected if similarity is found or service is used).");
  }

  console.log("\n--- Testing CapCut Blueprint ---");
  const capcut = await blueprintService.generateCapCutBlueprint({
    userId: 'test-user',
    platform: 'capcut',
    niche: 'Cooking Tutorials',
    productTitle: '5-Minute Pasta',
    targetAudience: 'Busy students'
  });
  console.log("CapCut Instructions length:", capcut.instructions.length);
}

testBlueprints().catch(console.error);
