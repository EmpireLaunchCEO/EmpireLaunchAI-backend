import { db, schema } from '../db/index.js';
const { styleDna } = schema;
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { resolveModelForUser, getDefaultModel } from '../utils/resolveModel.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

export class DnaLabService {
  constructor() {}

  /** Resolve a tier-appropriate model for the given user */
  private async getModel(userId: string): Promise<any> {
    return resolveModelForUser(userId);
  }

  /**
   * Processes viral content to extract Style DNA.
   * Note: Requires ffmpeg and ffprobe binaries in the environment.
   */
  async processViralContent(userId: string, platform: string, videoUrl: string) {
    console.log(`[DnaLab] Processing viral content for user ${userId} on ${platform}: ${videoUrl}`);
    
    let videoPath: string | null = null;
    try {
      videoPath = await this.downloadVideo(videoUrl);
      
      const pacing = await this.analyzePacing(videoPath);
      const palette = await this.analyzePalette(videoPath);
      const transcript = await this.extractTranscript(videoPath);
      
      // Use tier-aware narrative analysis
      const narrativeDna = await this.analyzeNarrativeForUser(userId, transcript, pacing);
      
      const dnaProfile = {
        visual_identity: {
          pacing,
          primary_palette: palette,
          typography_signature: {
            family: "Inter",
            position: "center",
            animation: "pop_in"
          }
        },
        narrative_dna: narrativeDna,
        audio_profile: {
          voice_type: "ai_female_energetic",
          background_music_genre: "trending_pop"
        }
      };

      const id = uuidv4();
      await db.insert(styleDna).values({
        id,
        userId,
        platform,
        styleDnaProfile: dnaProfile,
        isApproved: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return { id, dnaProfile };
    } catch (error) {
      console.error(`[DnaLab] Error processing content:`, error);
      throw error;
    } finally {
      if (videoPath && fs.existsSync(videoPath)) {
        try {
          fs.unlinkSync(videoPath);
        } catch (e) {
          console.error(`[DnaLab] Cleanup failed for ${videoPath}`);
        }
      }
    }
  }

  private async downloadVideo(url: string): Promise<string> {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });
    const tempPath = path.join('/tmp', `video-${uuidv4()}.mp4`);
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(tempPath));
      writer.on('error', reject);
    });
  }

  private async analyzePacing(videoPath: string): Promise<string> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.warn('[DnaLab] ffprobe failed or not installed, using mock pacing');
          return resolve('fast_cut');
        }
        const duration = metadata.format.duration || 0;
        if (duration < 15) resolve('fast_cut');
        else if (duration < 60) resolve('cinematic');
        else resolve('steady');
      });
    });
  }

  private async analyzePalette(videoPath: string): Promise<string[]> {
    const screenshotPath = path.join('/tmp', `thumb-${uuidv4()}.jpg`);
    try {
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .screenshots({
            timestamps: [1],
            filename: path.basename(screenshotPath),
            folder: path.dirname(screenshotPath)
          })
          .on('end', resolve)
          .on('error', (err) => {
            console.warn('[DnaLab] ffmpeg screenshot failed');
            reject(err);
          });
      });

      if (!fs.existsSync(screenshotPath)) {
          throw new Error('Screenshot not generated');
      }

      const { dominant } = await sharp(screenshotPath).stats();
      const hex = (r: number, g: number, b: number) => 
        '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
      
      return [hex(dominant.r, dominant.g, dominant.b)];
    } catch (error) {
      console.warn('[DnaLab] Palette analysis failed, using mock palette');
      return ['#FF5733', '#C70039']; // Vibrant mock colors
    } finally {
      if (fs.existsSync(screenshotPath)) {
          try {
              fs.unlinkSync(screenshotPath);
          } catch (e) {}
      }
    }
  }

  private async extractTranscript(videoPath: string): Promise<string> {
    // Mock transcript for prototype - in production, call Whisper API
    return "Welcome back! Today we are looking at the best strategies for digital marketing. Don't forget to like and follow for more. Check out the link in my bio for a free guide!";
  }

  /**
   * Processes a market listing/gig to extract Style DNA based on viral signals.
   */
  async extractMarketDna(userId: string, platform: string, rawData: any) {
    console.log(`[DnaLab] Extracting Market DNA for user ${userId} on ${platform}`);

    const activeModel = await this.getModel(userId);
    const masterBriefing = getMasterBriefing({ niche: rawData.niche || 'digital products', goal: 'Market Style Extraction', userTier: 'Intel Architect' });

    const template = `
      ${masterBriefing}

      Task: Extract high-fidelity Style DNA from this ${platform} listing:
      Title: {title}
      Raw Data: {rawData}

      Requirements:
      1. Identify the core color palette (hex codes).
      2. Identify typography (header/body fonts).
      3. Categorize layout complexity.
      4. Extract key copywriting triggers.

      Apply the Anti-Copycat Rule: Propose a synthesis that is technically unique.

      Return ONLY a JSON object matching this schema:
      {{
        "colorPalette": ["#hex1", "#hex2", "#hex3"],
        "typography": {{ "headerFont": "string", "bodyFont": "string", "fontVibe": "string" }},
        "layoutComplexity": "minimalist | structured_grid | organic_boho | retro_maximalist",
        "keyCopywritingTriggers": ["string"]
      }}
    `;

    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([prompt, activeModel, new JsonOutputParser()]);

    try {
      const styleDna = await chain.invoke({ title: rawData.title, rawData: JSON.stringify(rawData) });
      return styleDna;
    } catch (error) {
      console.error('[DnaLab] Market DNA extraction failed:', error);
      throw error;
    }
  }
}

export const dnaLabService = new DnaLabService();
