import { db, schema } from '../db/index.js';
const { paymentButtons } = schema;
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';

export class PaymentButtonService {
  async createButton(userId: string, productId: string, platform: string, buttonData: any, buttonType: string = 'link') {
    const id = randomUUID();
    await db.insert(paymentButtons).values({
      id,
      userId,
      productId,
      platform,
      buttonType,
      buttonData,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async getButtonsByUser(userId: string) {
    return await db.select()
      .from(paymentButtons)
      .where(eq(paymentButtons.userId, userId));
  }

  async getButtonsByProduct(productId: string) {
    return await db.select()
      .from(paymentButtons)
      .where(eq(paymentButtons.productId, productId));
  }

  async updateButton(buttonId: string, updates: Partial<any>) {
    await db.update(paymentButtons)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(paymentButtons.id, buttonId));
  }

  async deleteButton(buttonId: string) {
    await db.update(paymentButtons)
      .set({
        status: 'deleted',
        updatedAt: new Date(),
      })
      .where(eq(paymentButtons.id, buttonId));
  }
}

export const paymentButtonService = new PaymentButtonService();
