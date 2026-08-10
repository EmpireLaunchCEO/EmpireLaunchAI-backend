import { v4 as uuidv4 } from 'uuid';
import { eq, asc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { soraVideoService } from './soraVideoService.js';
import { renderingEngine } from './renderingEngine.js';
import { aiRouter } from './aiRouter.js';
import { r2Storage } from './r2StorageService.js';
export interface SceneScript { sceneNumber: number; duration: number; visualType: 'motion'|'still'; narration: string; visualPrompt: string; }
export interface VideoProjectInput { userId: string; title: string; idea: string; platforms?: string[]; style?: string; durationTarget?: number; script?: any; }
function trace(message: string) { process.stderr.write(`[SCENE_PIPELINE] ${message}\n`); }
function parseScenes(raw: any, idea: string, durationTarget = 30): SceneScript[] {
  const candidates = Array.isArray(raw?.scenes) ? raw.scenes : [];
  if (candidates.length) return candidates.map((s:any,i:number)=>({ sceneNumber:i+1,duration:Math.max(1,Number(s.duration)||Math.ceil(durationTarget/candidates.length)),visualType:s.visualType==='still'?'still':'motion',narration:String(s.narration||''),visualPrompt:String(s.visualPrompt||s.visual_prompt||idea) }));
  return [0,1,2].map((i)=>({sceneNumber:i+1,duration:Math.ceil(durationTarget/3),visualType:'motion' as const,narration:i===0?`Introducing ${idea}`:i===1?`Discover why ${idea} matters`:`Take the next step with ${idea}`,visualPrompt:`Original cinematic scene ${i+1} for: ${idea}`}));
}
export class SceneVideoPipelineService {
  async createProject(input: VideoProjectInput): Promise<string> {
    trace(`project_create_start user=${input.userId}`);
    const projectId = uuidv4();
    const duration = input.durationTarget || 30;
    let generatedScript = input.script;
    if (!generatedScript) {
      trace(`gpt52_script_start project=${projectId}`);
      try {
        const decision = await aiRouter.route({ userId: input.userId, request: `Create a JSON scene script for this video idea: ${input.idea}. Return scenes with sceneNumber, duration, visualType (motion or still), narration, and visualPrompt.`, mode: 'generate' });
        generatedScript = (decision as any).script || (decision as any).parameters?.script;
        trace(`gpt52_script_end project=${projectId} generated=${!!generatedScript}`);
      } catch (error: any) { trace(`gpt52_script_failed project=${projectId} error=${error.message}`); }
    }
    const script = parseScenes(generatedScript || {}, input.idea, duration);
    await db.insert(schema.videoProjects).values({id:projectId,userId:input.userId,title:input.title||input.idea.slice(0,80),status:'generating',totalDuration:script.reduce((a,s)=>a+s.duration,0),sceneCount:script.length,script,metadata:{platforms:input.platforms||[],style:input.style||''}});
    await db.insert(schema.videoScenes).values(script.map(s=>({id:uuidv4(),projectId,sceneNumber:s.sceneNumber,duration:s.duration,visualType:s.visualType,narration:s.narration,visualPrompt:s.visualPrompt,status:'pending'})));
    trace(`project_created id=${projectId} scenes=${script.length}`);
    void this.processProject(projectId, input.userId).catch(e=>trace(`worker_unhandled project=${projectId} error=${e?.message}`));
    return projectId;
  }
  async processProject(projectId:string,userId:string):Promise<void> {
    const scenes=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber));
    const assets:string[]=[];
    trace(`worker_start project=${projectId} scenes=${scenes.length}`);
    for (const scene of scenes) { await this.processScene(scene, userId); }
    const complete=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber));
    if (complete.some(s=>s.status!=='completed')) { await db.update(schema.videoProjects).set({status:'failed',updatedAt:new Date()}).where(eq(schema.videoProjects.id,projectId)); return; }
    for (const s of complete) if(s.assetUrl) assets.push(s.assetUrl);
    await db.update(schema.videoProjects).set({status:'completed',finalVideoUrl:assets[0]||null,updatedAt:new Date(),metadata:{sceneUrls:assets}}).where(eq(schema.videoProjects.id,projectId));
    trace(`project_complete project=${projectId} assets=${assets.length}`);
  }
  async processScene(scene:any,userId:string):Promise<void> {
    trace(`scene_start id=${scene.id} number=${scene.sceneNumber}`);
    await db.update(schema.videoScenes).set({status:'generating',updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));
    try {
      let localPath:string|undefined; let mime='video/mp4';
      if(scene.visualType==='still') { const result=await renderingEngine.renderImage(scene.visualPrompt); if(!result.success||!result.imageUrl) throw new Error(result.error||'GPT Image 2 failed'); localPath=result.imageUrl; mime='image/png'; }
      else { const result=await soraVideoService.generateVideo(scene.visualPrompt); if(!result.success||!result.videoPath) throw new Error(result.error||'Sora 2 failed'); localPath=result.videoPath; }
      trace(`scene_visual_complete id=${scene.id} type=${scene.visualType}`);
      let assetUrl=localPath;
      if(localPath && r2Storage.isAvailable) { const uploaded=await r2Storage.uploadLocalFile(localPath,userId,'video-scenes',mime); assetUrl=uploaded.url||localPath; }
      await db.update(schema.videoScenes).set({status:'completed',assetUrl,assetType:mime,metadata:{provider:scene.visualType==='still'?'gpt-image-2':'sora-2',narration:scene.narration},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));
      trace(`scene_complete id=${scene.id}`);
    } catch(error:any) { trace(`scene_failed id=${scene.id} error=${error.message}`); await db.update(schema.videoScenes).set({status:'failed',metadata:{error:error.message},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id)); }
  }
  async getProject(projectId:string,userId:string) { const [project]=await db.select().from(schema.videoProjects).where(eq(schema.videoProjects.id,projectId)); if(!project||project.userId!==userId)return null; const scenes=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber)); const done=scenes.filter(s=>s.status==='completed').length; return {project,scenes,progress:scenes.length?Math.round(done/scenes.length*100):0}; }
  async regenerateScene(sceneId:string,userId:string) { const [scene]=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.id,sceneId)); if(!scene)return null; const project=await this.getProject(scene.projectId,userId); if(!project)return null; await this.processScene(scene,userId); await this.processProject(scene.projectId,userId); return scene.projectId; }
}
export const sceneVideoPipelineService = new SceneVideoPipelineService();
