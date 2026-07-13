import { db, schema } from '../db/index.js';
const { ownershipVault } = schema;
import { eq, and } from 'drizzle-orm';
import { encrypt, decrypt } from '../utils/security.js';
import { encryptWithEnvelope, decryptWithEnvelope } from '../utils/encryption.js';
import { v4 as uuidv4 } from 'uuid';

export class VaultService {
  /**
   * Securely stores a secret in the Ownership Vault using standard encryption.
   */
  async storeSecret(userId: string, platform: string, secretType: string, value: string) {
    const encrypted = encrypt(value);
    const [iv, tag, encryptedValue] = encrypted.split(':');

    const existing = await db.select()
      .from(ownershipVault)
      .where(and(
        eq(ownershipVault.userId, userId),
        eq(ownershipVault.platform, platform.toUpperCase()),
        eq(ownershipVault.secretType, secretType.toUpperCase())
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(ownershipVault)
        .set({
          encryptedValue,
          iv,
          tag,
          encryptedDek: null,
          lastRotated: new Date(),
        })
        .where(eq(ownershipVault.id, existing[0].id));
      return existing[0].id;
    } else {
      const id = uuidv4();
      await db.insert(ownershipVault).values({
        id,
        userId,
        platform: platform.toUpperCase(),
        secretType: secretType.toUpperCase(),
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
   * Securely stores a secret using Envelope Encryption (AES-256-GCM + unique DEK per secret).
   */
  async storeSecretWithEnvelope(userId: string, platform: string, secretType: string, value: string) {
    const { encryptedValue, encryptedDek, iv, tag } = encryptWithEnvelope(value);

    const existing = await db.select()
      .from(ownershipVault)
      .where(and(
        eq(ownershipVault.userId, userId),
        eq(ownershipVault.platform, platform.toUpperCase()),
        eq(ownershipVault.secretType, secretType.toUpperCase())
      ))
      .limit(1);

    if (existing.length > 0) {
      await db.update(ownershipVault)
        .set({
          encryptedValue,
          encryptedDek,
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
        platform: platform.toUpperCase(),
        secretType: secretType.toUpperCase(),
        encryptedValue,
        encryptedDek,
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
   * Automatically detects if envelope encryption was used.
   */
  async getSecret(userId: string, platform: string, secretType: string): Promise<string | null> {
    const results = await db.select()
      .from(ownershipVault)
      .where(and(
        eq(ownershipVault.userId, userId),
        eq(ownershipVault.platform, platform.toUpperCase()),
        eq(ownershipVault.secretType, secretType.toUpperCase())
      ))
      .limit(1);

    if (results.length === 0) return null;

    const secret = results[0];
    
    if (secret.encryptedDek) {
      return decryptWithEnvelope(secret.encryptedValue, secret.encryptedDek, secret.iv, secret.tag);
    } else {
      const encryptedText = `${secret.iv}:${secret.tag}:${secret.encryptedValue}`;
      return decrypt(encryptedText);
    }
  }

  /**
   * Delete a secret from the vault.
   */
  async deleteSecret(userId: string, platform: string, secretType: string): Promise<void> {
    await db.delete(ownershipVault)
      .where(and(
        eq(ownershipVault.userId, userId),
        eq(ownershipVault.platform, platform.toUpperCase()),
        eq(ownershipVault.secretType, secretType.toUpperCase())
      ));
  }
}

export const vaultService = new VaultService();
