export interface EmailOptions {
  to: string;
  subject: string;
  body: string;
}

export class EmailService {
  async sendEmail(options: EmailOptions): Promise<boolean> {
    console.log(`Sending email to: ${options.to}`);
    console.log(`Subject: ${options.subject}`);
    // console.log(`Body: ${options.body}`);
    // Mocking email sending
    return true;
  }

  async sendThankYouEmail(customerEmail: string, productName: string): Promise<boolean> {
    const body = `
      Hi there,
      
      Thank you for purchasing ${productName}! 
      We hope you enjoy it. 
      
      If you have a moment, we would love to hear your feedback. 
      Please leave a review on our store.
      
      Best,
      Bizrunner Shop
    `;
    
    return this.sendEmail({
      to: customerEmail,
      subject: `Thank you for your purchase of ${productName}!`,
      body: body
    });
  }
}

export const emailService = new EmailService();
