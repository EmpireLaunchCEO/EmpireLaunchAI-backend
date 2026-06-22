import { resolveStudioReasoner } from '../utils/resolveModel.js';

export interface ThankYouDraft {
  subject: string;
  body: string;
  tone: 'warm' | 'professional' | 'enthusiastic' | 'luxury';
  suggestedReviewCta: string;
  personalizationTags: string[];
}

/**
 * AI Thank-You Drafter — generates personalized, high-converting
 * post-purchase emails using Gemini's strategic intelligence.
 * Each draft is crafted to maximize review conversion and customer loyalty.
 */
export class AiThankYouDrafter {

  /**
   * Draft a personalized thank-you email for a recent purchase.
   * Uses Gemini to analyze product + customer context and generate
   * persuasive, on-brand messaging.
   */
  async draftThankYou(params: {
    productName: string;
    customerName?: string;
    niche: string;
    price?: number;
    orderId?: string;
    pastPurchases?: string[];
    preferredTone?: 'warm' | 'professional' | 'enthusiastic' | 'luxury';
  }): Promise<ThankYouDraft> {
    const model = await resolveStudioReasoner();

    const prompt = `You are a post-purchase loyalty copywriter.
      
Draft a thank-you email for a customer who just purchased "${params.productName}" in the "${params.niche}" niche.

Context:
- Product: ${params.productName}
- Niche: ${params.niche}
- Customer Name: ${params.customerName || 'Valued Customer'}
- Order Value: $${params.price || 'N/A'}
- Past Purchases: ${params.pastPurchases?.join(', ') || 'First time buyer'}
- Preferred Tone: ${params.preferredTone || 'warm'}

CRITICAL RULES:
1. Make it feel personal and genuine, not template-like
2. Include a natural, low-pressure invitation to leave a review
3. The subject line must achieve 25%+ open rate
4. Keep the body under 200 words
5. Include a subtle upsell/next-step suggestion

Return JSON ONLY:
{
  "subject": "string (compelling, personalized subject line)",
  "body": "string (email body in plain text, max 200 words)",
  "tone": "warm|professional|enthusiastic|luxury",
  "suggestedReviewCta": "string (a natural CTA for review)",
  "personalizationTags": ["string"]
}`;

    const response = await model.invoke([
      { role: 'system', content: 'You generate personalized post-purchase emails. Return ONLY valid JSON.' },
      { role: 'human', content: prompt },
    ]);

    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const json = content.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();

    try {
      const parsed = JSON.parse(json);
      return {
        subject: parsed.subject || `Thank you for your ${params.productName} purchase!`,
        body: parsed.body || this.createFallbackBody(params),
        tone: parsed.tone || 'warm',
        suggestedReviewCta: parsed.suggestedReviewCta || `We'd love to hear your thoughts on ${params.productName}!`,
        personalizationTags: parsed.personalizationTags || [params.productName, params.niche],
      };
    } catch {
      return {
        subject: `Thank you for your ${params.productName} purchase!`,
        body: this.createFallbackBody(params),
        tone: 'warm',
        suggestedReviewCta: `We'd love to hear your thoughts on ${params.productName}!`,
        personalizationTags: [params.productName, params.niche],
      };
    }
  }

  /**
   * Draft a review request follow-up email (sent 3-7 days after purchase).
   */
  async draftReviewRequest(params: {
    productName: string;
    customerName?: string;
    niche: string;
    daysSincePurchase: number;
  }): Promise<ThankYouDraft> {
    const model = await resolveStudioReasoner();

    const prompt = `Draft a friendly review request email for a customer who purchased "${params.productName}" ${params.daysSincePurchase} days ago.

Niche: ${params.niche}
Customer: ${params.customerName || 'Valued Customer'}

Make it natural and helpful, not pushy. Return JSON with subject, body, suggestedReviewCta, and personalizationTags.`;

    const response = await model.invoke([
      { role: 'system', content: 'Return ONLY valid JSON.' },
      { role: 'human', content: prompt },
    ]);

    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const json = content.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();

    try {
      return JSON.parse(json);
    } catch {
      return {
        subject: `How are you enjoying ${params.productName}?`,
        body: `Hi ${params.customerName || 'there'},\n\nIt's been ${params.daysSincePurchase} days since you got ${params.productName} — we'd love to hear how it's working for you!\n\nYour feedback helps us improve and helps other customers make informed decisions.\n\nBest,\nThe Team`,
        tone: 'warm',
        suggestedReviewCta: `Share your experience with ${params.productName}`,
        personalizationTags: [params.productName, params.niche],
      };
    }
  }

  private createFallbackBody(params: any): string {
    const name = params.customerName || 'there';
    return [
      `Hi ${name},`,
      ``,
      `Thank you so much for purchasing ${params.productName}!`,
      `We're thrilled to have you as a customer.`,
      ``,
      `If you have any questions or need assistance, just reply to this email.`,
      `We're here to help!`,
      ``,
      `Best regards,`,
      `The Empire Team`,
    ].join('\n');
  }
}

export const aiThankYouDrafter = new AiThankYouDrafter();