import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const MASTER_KEY = process.env.ENCRYPTION_KEY || 'default_master_key_32_chars_long_!!';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(MASTER_KEY), iv) as crypto.CipherGCM;
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

export function decrypt(text: string): string {
  const [ivHex, authTagHex, encryptedHex] = text.split(':');
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error('Invalid encrypted text format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(MASTER_KEY), iv) as crypto.DecipherGCM;
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Envelope Encryption:
 * 1. Generate a random DEK.
 * 2. Encrypt the DEK with the Master Key.
 * 3. Encrypt the text with the DEK.
 */
export function encryptWithEnvelope(text: string) {
  const dek = crypto.randomBytes(32);
  const encryptedDek = encrypt(dek.toString('hex'));

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, dek, iv) as crypto.CipherGCM;
  let encryptedValue = cipher.update(text, 'utf8', 'hex');
  encryptedValue += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    encryptedValue,
    encryptedDek,
    iv: iv.toString('hex'),
    tag
  };
}

export function decryptWithEnvelope(encryptedValue: string, encryptedDek: string, ivHex: string, tagHex: string) {
  const dekHex = decrypt(encryptedDek);
  const dek = Buffer.from(dekHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, dek, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedValue, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
