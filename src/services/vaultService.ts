import { db, schema } from '../db/index.js';
const { ownershipVault } = schema;
import { eq, and } from 'drizzle-orm';
import { encrypt, decrypt } from '../utils/security.js';
import { v4 as uuidv4 } from 'uuid';

export class VaultService {
  /**
   * Securely stores a secret in the Ownership Vault.
   */
  async storeSecret(userId: string, platform: string, secretType: string, value: string) {
    const encrypted = encrypt(value);
    const [iv, tag, encryptedValue] = encrypted.split(':');

    const existing = await db.select()
      .from(ownershipVault)
      .where(and(
        eq(ownershipVault.userId, userId),
        eq(ownershipVault.platform, platform),
        eq(ownershipVault.secretType, secretType)
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(ownershipVault)
        .set({
          encryptedValue,
          iv,
          tag,
          lastRotated: new Date(),
        })
        .where(eq(ownershipVault.id, existing[0].id));
      return existing[0].id;
    } else {
      const id = uuidv4();
      await db.insert(ownershipVault).values({
        id,
        userId,
        platform,
        secretType,
        encryptedValue,
        iv,
        tag,
        lastRotated: new Date(),
        createdAt: new Date(),
      });
      return id;
    }
  }

  /**
   * Retrieves and decrypts a secret from the Ownership Vault.
   */
  async getSecret(userId: string, platform: string, secretType: string): Promise<string | null> {
    const results = await db.select()
      .from(ownershipVault)
      .where(and(
        eq(ownershipVault.userId, userId),
        eq(ownershipVault.platform, platform),
        eq(ownershipVault.secretType, secretType)
      ))
      .limit(1);

    if (results.length === 0) return null;

    const secret = results[0];
    const encryptedText = `${secret.iv}:${secret.tag}:${secret.encryptedValue}`;
    return decrypt(encryptedText);
  }
}

export const vaultService = new VaultService();
