import { dnaVaultService } from '../services/dnaVaultService.js';
import { db, schema } from '../db/index.js';
const { dnaStrands } = schema;

async function seed() {
  console.log('🌱 Seeding DNA Vault...');
  
  try {
    const count = await dnaVaultService.seedPremiumArchetypes();
    console.log(`✅ Seeded ${count} archetypes.`);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
  }
}

seed().then(() => process.exit(0));
