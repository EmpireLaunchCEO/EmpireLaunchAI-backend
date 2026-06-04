import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { resolveModelForUser } from '../utils/resolveModel.js';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const { approvals } = schema;

export class InboxAssistantService {
  /** Resolve a tier-appropriate model for the given user */
  private async getModel(userId: string): Promise<BaseChatModel> {
    return resolveModelForUser(userId);
  }

  async generateThankYouDraft(userId: string, customerName: string, itemName: string, platform: string) {
    console.log(`[InboxAssistant] Generating thank you draft for user: ${userId}, customer: ${customerName}`);

    const template = `
      You are the "Inbox Assistant" for a business owner.
      Your goal is to build trust with customers by sending a warm, professional, and personalized thank you message after a purchase.
      You should also gently ask for a review if they are satisfied with their purchase.

      Customer Name: {customerName}
      Item Purchased: {itemName}
      Platform: {platform}

      Task: Write a high-intelligence message draft.
      Ensure it doesn't sound generic. Be intellectual and sincere.
      
      Return the draft in the following JSON format:
      {{
        "subject": "Thank you for your purchase!",
        "body": "The message body here..."
      }}
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const activeModel = await this.getModel(userId);
    const chain = RunnableSequence.from([
      prompt,
      activeModel,
      new StringOutputParser(),
    ]);

    const result = await chain.invoke({
      customerName,
      itemName,
      platform,
    });

    let draft;
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      draft = JSON.parse(jsonMatch ? jsonMatch[0] : result);
    } catch (e) {
      console.error("[InboxAssistant] Failed to parse draft:", e);
      draft = {
        subject: `Thank you for your ${itemName} purchase!`,
        body: `Hi ${customerName}, thank you so much for your purchase from our shop on ${platform}. We hope you love the ${itemName}! If you have a moment, we'd greatly appreciate a review.`
      };
    }

    // Create an approval record for the draft
    const approvalId = uuidv4();
    await db.insert(approvals).values({
      id: approvalId,
      userId,
      type: 'inbox_draft',
      payload: {
        platform,
        customerName,
        itemName,
        draft
      },
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return { approvalId, draft };
  }
}

export const inboxAssistantService = new InboxAssistantService();