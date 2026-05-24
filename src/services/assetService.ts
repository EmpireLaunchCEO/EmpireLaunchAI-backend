import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

export class AssetService {
  private readonly stagingPath = 'public/assets/staging';

  constructor() {
    if (!fs.existsSync(this.stagingPath)) {
      fs.mkdirSync(this.stagingPath, { recursive: true });
    }
  }

  /**
   * Downloads an asset from a URL and stages it in S3 (simulated).
   */
  async stageAsset(url: string, tenantId: string, extension: string = 'pdf') {
    const fileName = `${tenantId}_${uuidv4()}.${extension}`;
    const filePath = path.join(this.stagingPath, fileName);

    console.log(`Staging asset from ${url} to ${filePath}`);

    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise<{ url: string, path: string }>((resolve, reject) => {
      writer.on('finish', () => {
        // In a real S3 implementation, this would upload to an S3 bucket
        // and return the S3 URL. Here we return a local URL.
        const assetUrl = `/assets/staging/${fileName}`;
        resolve({ url: assetUrl, path: filePath });
      });
      writer.on('error', reject);
    });
  }

  /**
   * Cleans up aged staging assets.
   */
  async cleanupStaging(olderThanHours: number = 24) {
    // Implementation for periodic cleanup
  }
}

export const assetService = new AssetService();
