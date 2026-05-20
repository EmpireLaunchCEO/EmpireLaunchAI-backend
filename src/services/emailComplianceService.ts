export class EmailComplianceService {
  /**
   * Ensures that the email content meets legal requirements.
   * Currently checks for sender identity and unsubscribe links.
   */
  async enforceCompliance(userId: string, content: string): Promise<string> {
    let compliantContent = content;

    // Check for sender identity placeholder
    if (!compliantContent.includes('[SENDER_IDENTITY_PLACEHOLDER]')) {
      compliantContent += '\n\n--\nBizrunner Automated Support';
    } else {
      // In a real app, replace with actual user/business name
      compliantContent = compliantContent.replace('[SENDER_IDENTITY_PLACEHOLDER]', 'Bizrunner Automated Support');
    }

    // Check for unsubscribe link
    if (!compliantContent.includes('[UNSUBSCRIBE_LINK_PLACEHOLDER]')) {
      compliantContent += '\n\nTo unsubscribe from these emails, please click here: https://EmpireLaunch AI.ai/unsubscribe';
    } else {
      compliantContent = compliantContent.replace('[UNSUBSCRIBE_LINK_PLACEHOLDER]', 'https://EmpireLaunch AI.ai/unsubscribe');
    }

    return compliantContent;
  }

  /**
   * Validates if the content is compliant.
   */
  validate(content: string): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!content.includes('unsubscribe') && !content.includes('UNSUBSCRIBE')) {
      missing.push('unsubscribe link');
    }
    // Simple check for some form of identity
    if (!content.includes('Sent by') && !content.includes('Bizrunner') && !content.includes('Best regards')) {
      missing.push('sender identity');
    }
    
    return {
      valid: missing.length === 0,
      missing
    };
  }
}

export const emailComplianceService = new EmailComplianceService();
