
import { db, schema } from '../src/db/index.js';
const { users } = schema;
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

function hashPassword(password: string): string {
  return crypto.pbkdf2Sync(password, 'empire-launch-salt', 1000, 64, 'sha512').toString('hex');
}

async function run() {
  const email = 'stacipeabody@gmail.com';
  const password = 'Makeithappen2026';
  const passwordHash = hashPassword(password);

  console.log(`Setting password for ${email}...`);

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (user) {
    await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    console.log('Password updated successfully.');
  } else {
    console.log('User not found. Creating owner account...');
    const { v4: uuidv4 } = await import('uuid');
    const userId = uuidv4();
    await db.insert(users).values({
      id: userId,
      email,
      passwordHash,
      tier: 'EMPIRE_MASTER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('Owner account created successfully.');
  }
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
