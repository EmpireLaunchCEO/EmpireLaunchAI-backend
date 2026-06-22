import axios from 'axios';
import { db, schema } from '../db/index.js';
const { ownershipVault, users } = schema;
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export class PaypalService {
  private clientId = process.env.PAYPAL_CLIENT_ID;
  private clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  private mode = process.env.PAYPAL_MODE || 'sandbox';
  private baseUrl = this.mode === 'sandbox' 
    ? 'https://api-m.sandbox.paypal.com' 
    : 'https://api-m.paypal.com';

  private encryptionKey = process.env.VAULT_ENCRYPTION_KEY || 'default-secret-key-32-chars-long!!';

  private encrypt(value: string) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(this.encryptionKey), iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return {
      encryptedValue: encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex')
    };
  }

  async getAccessToken() {
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await axios.post(`${this.baseUrl}/v1/oauth2/token`, 'grant_type=client_credentials', {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    return response.data.access_token;
  }

  async generateOnboardingLink(userId: string, returnUrl: string) {
    const accessToken = await this.getAccessToken();
    const response = await axios.post(`${this.baseUrl}/v2/customer/partner-referrals`, {
      operations: [
        {
          operation: 'API_INTEGRATION',
          api_integration_preference: {
            rest_api_integration: {
              integration_method: 'PAYPAL',
              integration_type: 'THIRD_PARTY',
              rest_third_party_details: {
                feature_list: ['PAYMENT', 'REFUND', 'PARTNER_FEE']
              }
            }
          }
        }
      ],
      products: ['EXPRESS_CHECKOUT'],
      legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
      partner_config_override: { return_url: returnUrl }
    }, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const link = response.data.links.find((l: any) => l.rel === 'action_url').href;
    return { onboardingUrl: link };
  }

  async saveMerchantConnection(userId: string, merchantId: string, refreshToken?: string) {
    if (refreshToken) {
      const { encryptedValue, iv, tag } = this.encrypt(refreshToken);
      // @ts-ignore
      await db.insert(ownershipVault).values({
        id: uuidv4(),
        userId,
        platform: 'paypal',
        secretType: 'OAUTH_REFRESH',
        encryptedValue,
        iv,
        tag,
        lastRotated: new Date(),
        createdAt: new Date()
      });
    }

    // @ts-ignore
    await db.update(users)
      .set({ paypalMerchantId: merchantId, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }
}

export const paypalService = new PaypalService();
