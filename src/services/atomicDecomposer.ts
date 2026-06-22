import { v4 as uuidv4 } from 'uuid';

export interface AtomicStep {
  id: string;
  objective: string;
  parameters: any;
  stepIndex: number;
}

export class AtomicDecomposer {
  decompose(taskId: string, objective: string, parameters: any): AtomicStep[] {
    switch (objective) {
      case 'CREATE_PRODUCT':
      case 'CREATE_ETSY_LISTING':
        return this.decomposeEtsyListing(parameters);
      case 'GENERATE_SOCIAL_CONTENT':
      case 'GENERATE_CANVA_CONTENT':
        return this.decomposeCanvaContent(parameters);
      default:
        throw new Error(`Unsupported objective for decomposition: ${objective}`);
    }
  }

  private decomposeEtsyListing(parameters: any): AtomicStep[] {
    const steps: AtomicStep[] = [
      {
        id: uuidv4(),
        objective: 'ETSY_SEARCH_TRENDS',
        parameters: { niche: parameters.niche },
        stepIndex: 0,
      },
      {
        id: uuidv4(),
        objective: 'GENERATE_LISTING_COPY',
        parameters: { niche: parameters.niche, trends: '{{ETSY_SEARCH_TRENDS.result}}' },
        stepIndex: 1,
      },
      {
        id: uuidv4(),
        objective: 'ETSY_CREATE_LISTING',
        parameters: { 
          shopId: parameters.shopId, 
          title: '{{GENERATE_LISTING_COPY.title}}', 
          description: '{{GENERATE_LISTING_COPY.description}}',
          price: parameters.price || 1000,
          quantity: parameters.quantity || 1,
        },
        stepIndex: 2,
      }
    ];
    return steps;
  }

  private decomposeCanvaContent(parameters: any): AtomicStep[] {
    const steps: AtomicStep[] = [
      {
        id: uuidv4(),
        objective: 'CANVA_SEARCH_TEMPLATES',
        parameters: { ...parameters, style: parameters.style || 'Minimalist', tier: 'free' },
        stepIndex: 0,
      },
      {
        id: uuidv4(),
        objective: 'GENERATE_CANVA_DATA',
        parameters: { niche: parameters.niche, templateId: '{{CANVA_SEARCH_TEMPLATES.result[0]}}' },
        stepIndex: 1,
      },
      {
        id: uuidv4(),
        objective: 'CANVA_AUTOFILL_DESIGN',
        parameters: { 
          templateId: '{{CANVA_SEARCH_TEMPLATES.result[0]}}', 
          data: '{{GENERATE_CANVA_DATA.result}}',
          tier: 'free'
        },
        stepIndex: 2,
      },
      {
        id: uuidv4(),
        objective: 'CANVA_EXPORT_DESIGN',
        parameters: { designId: '{{CANVA_AUTOFILL_DESIGN.result}}' },
        stepIndex: 3,
      }
    ];
    return steps;
  }
}

export const atomicDecomposer = new AtomicDecomposer();
