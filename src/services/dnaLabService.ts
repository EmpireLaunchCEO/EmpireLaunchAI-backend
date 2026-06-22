import { db } from '../db/index.js';
import { styleDna } from '../db/sqlite-schema.js';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { ChatOpenAI } from "@langchain/openai";
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { resolveModelForUser } from '../utils/resolveModel.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

export class DnaLabService {
  private model: ChatOpenAI;

  constructor() {
    // Default model for background processes where userId isn't immediately available
    // or as a fallback before tier resolution.
    this.model = new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0.2,
      openAIApiKey: process.env.OPENAI_API_KEY,
    });
  }

  /** Resolve a tier-appropriate model for the given user */
  private async getModel(userId: string): Promise<ChatOpenAI> {
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
   * Analyze narrative DNA with tier-appropriate AI for the given user.
   */
  async analyzeNarrativeForUser(userId: string, transcript: string, pacing: string) {
    const activeModel = await this.getModel(userId);
    const template = `
      Analyze the following video transcript and pacing to extract Narrative DNA.
      Transcript: {transcript}
      Pacing: {pacing}

      Return ONLY a JSON object.
      {{
        "hook_style": "direct_question | visual_shock | story_start",
        "cta_pattern": "link_in_bio | follow_for_more | check_comments",
        "pacing_curve": "high_start_stable_mid | consistent_high | slow_build"
      }}
    `;
    const prompt = PromptTemplate.fromTemplate(template);
    const chain = RunnableSequence.from([
      prompt,
      activeModel,
      new JsonOutputParser(),
    ]);

    try {
      return await chain.invoke({ transcript, pacing });
    } catch (error) {
      console.error('[DnaLab] Narrative analysis failed, using default');
      return {
        hook_style: "story_start",
        cta_pattern: "link_in_bio",
        pacing_curve: "high_start_stable_mid"
      };
    }
  }
}

export const dnaLabService = new DnaLabService();
