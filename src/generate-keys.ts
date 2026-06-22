import { db, schema } from './db/index.js';
const { accessKeys } = schema;
import { v4 as uuidv4 } from 'uuid';

async function generateKeys() {
  try {
    const ownerMasterKey = {
      id: uuidv4(),
      key: `OWNER-${uuidv4()}`,
      tier: 'OWNER_MASTER',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const betaTesterKey = {
      id: uuidv4(),
      key: `BETA-${uuidv4()}`,
      tier: 'BETA_TESTER',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(accessKeys).values([ownerMasterKey, betaTesterKey]);
    
    console.log('Keys generated successfully:');
    console.log('Owner Master Key:', ownerMasterKey.key);
    console.log('Beta Tester Key:', betaTesterKey.key);
    process.exit(0);
  } catch (error) {
    console.error('Error generating keys:', error);
    process.exit(1);
  }
}

generateKeys();
