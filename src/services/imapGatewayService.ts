import { ImapFlow } from 'imapflow';

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass?: string;
    accessToken?: string;
  };
}

export interface DiscoveryPattern {
  platform: string;
  regex: RegExp;
  type: string;
}

export class ImapGatewayService {
  async scan(config: ImapConfig, patterns: DiscoveryPattern[]) {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth,
      logger: false
    });

    await client.connect();

    const matches: any[] = [];
    let lock = await client.getMailboxLock('INBOX');
    try {
      // Fetch the last 7 days of messages to scan
      const searchCriteria = {
        since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) 
      };

      for await (const message of client.fetch(searchCriteria, {
        envelope: true,
        source: { start: 0, maxLength: 10000 } // Peek first 10KB of the message
      })) {
        if (message.source) {
          const body = message.source.toString('utf8');

          for (const pattern of patterns) {
            const match = body.match(pattern.regex);
            if (match) {
              const rawKey = match[1];
              const startIdx = Math.max(0, match.index! - 50);
              const endIdx = Math.min(body.length, match.index! + match[0].length + 50);
              const snippet = body.substring(startIdx, endIdx).replace(/\n/g, ' ');

              matches.push({
                platform: pattern.platform,
                key: rawKey,
                type: pattern.type,
                snippet: `...${snippet}...`
              });
            }
          }
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    return matches;
  }
}

export const imapGatewayService = new ImapGatewayService();
