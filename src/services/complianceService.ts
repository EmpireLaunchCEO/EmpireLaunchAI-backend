import fs from 'fs';

export class ComplianceService {
  private wisdom: any;

  constructor() {
    try {
      const data = fs.readFileSync('/home/team/shared/business_wisdom.json', 'utf8');
      this.wisdom = JSON.parse(data);
    } catch (error) {
      console.error('Error loading business wisdom:', error);
      this.wisdom = {};
    }
  }

  async validateListing(platform: string, data: any): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    
    // Generic validation
    if (!data.title || data.title.length < 5) errors.push('Title is too short');
    if (!data.description || data.description.length < 20) errors.push('Description is too short');
    if (!data.price || data.price <= 0) errors.push('Invalid price');

    // Platform specific validation based on wisdom (Platform Guideline Library)
    const requirements = this.wisdom.listing_requirements?.[platform];
    
    if (requirements) {
      if (requirements.title_max_length && data.title.length > requirements.title_max_length) {
        errors.push(`${platform} title exceeds ${requirements.title_max_length} characters`);
      }
      
      if (requirements.tags_max_count && data.tags && data.tags.length > requirements.tags_max_count) {
        errors.push(`${platform} allows maximum ${requirements.tags_max_count} tags`);
      }
      
      if (requirements.min_images && (!data.images || data.images.length < requirements.min_images)) {
        errors.push(`${platform} requires at least ${requirements.min_images} image(s)`);
      }
      
      if (requirements.description_min_length && data.description.length < requirements.description_min_length) {
        errors.push(`${platform} description must be at least ${requirements.description_min_length} characters`);
      }
      
      if (requirements.vendor_required && !data.vendor) {
        errors.push(`${platform} requires a vendor`);
      }
      
      if (requirements.brand_required && !data.brand) {
        errors.push(`${platform} requires a brand`);
      }
      
      if (requirements.sku_required && !data.sku) {
        errors.push(`${platform} requires an SKU`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  getPlatformFees(platform: string) {
    return this.wisdom.platform_fees?.[platform] || {};
  }
}

export const complianceService = new ComplianceService();
