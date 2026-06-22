import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

export interface ImageProcessingOptions {
  width?: number;
  height?: number;
  textOverlay?: string;
  watermark?: string;
}

export interface VideoProcessingOptions {
  clips: string[];
  outputName: string;
  audioPath?: string;
  textOverlays?: { text: string; startTime: number; duration: number }[];
}

export class MediaService {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(process.cwd(), 'public', 'assets', 'temp');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async processImage(inputPath: string, outputPath: string, options: ImageProcessingOptions): Promise<string> {
    console.log(`Processing image: ${inputPath}`);
    let image = sharp(inputPath);

    if (options.width || options.height) {
      image = image.resize(options.width, options.height);
    }

    // Text overlay using SVG
    if (options.textOverlay) {
      const svgText = `
        <svg width="${options.width || 800}" height="${options.height || 600}">
          <style>
            .title { fill: white; font-size: 40px; font-weight: bold; font-family: sans-serif; }
          </style>
          <text x="50%" y="50%" text-anchor="middle" class="title">${options.textOverlay}</text>
        </svg>
      `;
      image = image.composite([{
        input: Buffer.from(svgText),
        gravity: 'center'
      }]);
    }

    await image.toFile(outputPath);
    return outputPath;
  }

  async generateVideo(options: VideoProcessingOptions): Promise<string> {
    const outputPath = path.join(this.tempDir, options.outputName);
    console.log(`Generating video: ${outputPath}`);

    return new Promise((resolve, reject) => {
      let command = ffmpeg();

      options.clips.forEach(clip => {
        command = command.input(clip);
      });

      if (options.audioPath) {
        command = command.input(options.audioPath);
      }

      command
        .on('start', (cmd) => console.log('FFmpeg command: ' + cmd))
        .on('error', (err) => {
          console.error('Error generating video:', err);
          reject(err);
        })
        .on('end', () => {
          console.log('Video generation finished');
          resolve(outputPath);
        })
        .mergeToFile(outputPath, this.tempDir);
    });
  }

  // Simplified "Internalized" content creation
  async createProductImage(productName: string, trendingNiche: string): Promise<string> {
    const outputPath = path.join(this.tempDir, `product_${Date.now()}.png`);
    
    // Create a base colored background if no template exists
    await sharp({
      create: {
        width: 1080,
        height: 1080,
        channels: 4,
        background: { r: 100, g: 150, b: 250, alpha: 1 }
      }
    })
    .composite([{
      input: Buffer.from(`
        <svg width="1080" height="1080">
          <rect width="100%" height="100%" fill="none" stroke="white" stroke-width="20" />
          <text x="50%" y="40%" text-anchor="middle" font-size="80" fill="white" font-family="Arial">${productName}</text>
          <text x="50%" y="60%" text-anchor="middle" font-size="50" fill="white" font-family="Arial">Trending in ${trendingNiche}</text>
          <text x="50%" y="80%" text-anchor="middle" font-size="30" fill="white" font-family="Arial">Bizrunner AI Powered</text>
        </svg>
      `),
      gravity: 'center'
    }])
    .toFile(outputPath);

    return outputPath;
  }
}

export const mediaService = new MediaService();
