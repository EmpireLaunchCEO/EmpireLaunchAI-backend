import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { eq, asc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { soraVideoService } from './soraVideoService.js';
import { renderingEngine } from './renderingEngine.js';
import { aiRouter } from './aiRouter.js';
import { r2Storage } from './r2StorageService.js';
export interface SceneScript { sceneNumber: number; duration: number; visualType: 'motion'|'still'; narration: string; visualPrompt: string; }
export interface VideoProjectInput { userId: string; title: string; idea: string; platforms?: string[]; style?: string; durationTarget?: number; script?: any; }
function trace(message: string) { process.stderr.write(`[SCENE_PIPELINE] ${message}\n`); }
function renderClip(input: string, output: string, duration: number, audio?: string): Promise<void> { return new Promise((resolve,reject)=>{ const cmd=ffmpeg(input); if(audio) cmd.input(audio).outputOptions(['-map 0:v:0','-map 1:a:0','-shortest']); cmd.loop(duration).videoCodec('libx264').size('1080x1920').audioCodec('aac').outputOptions('-pix_fmt yuv420p').on('end',()=>resolve()).on('error',reject).save(output); }); }
function concatClips(inputs: string[], output: string): Promise<void> { return new Promise((resolve,reject)=>{ const cmd=ffmpeg(); inputs.forEach(i=>cmd.input(i)); cmd.mergeToFile(output,path.dirname(output)).on('end',()=>resolve()).on('error',reject); }); }
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
  async processProject(projectId:string,userId:string,skipGeneration=false):Promise<void> {
    const scenes=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber));
    trace(`worker_start project=${projectId} scenes=${scenes.length}`);
    if (!skipGeneration) { const outcomes = await Promise.allSettled(scenes.map(scene=>this.processScene(scene,userId))); const rejected = outcomes.filter(o=>o.status==='rejected').length; if (rejected) trace(`scene_queue_rejections project=${projectId} count=${rejected}`); }
    const complete=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber));
    if (complete.some(s=>s.status!=='completed')) {
      const failedCount = complete.filter(s=>s.status==='failed').length;
      await db.update(schema.videoProjects).set({
        status:'failed',
        metadata: { failedSceneCount: failedCount, totalScenes: complete.length },
        updatedAt:new Date()
      }).where(eq(schema.videoProjects.id,projectId));
      return;
    }

    // Transition to assembling
    await db.update(schema.videoProjects).set({status:'assembling',updatedAt:new Date()}).where(eq(schema.videoProjects.id,projectId));
    trace(`assembling_start project=${projectId}`);

    try {
      const dir=path.join(process.cwd(),'temp','scene-projects',projectId); fs.mkdirSync(dir,{recursive:true});
      const clips:string[]=[];
      for (const scene of complete) {
        const local=String((scene.metadata as any)?.localPath||'');
        if(!local||!fs.existsSync(local)) { trace(`scene_missing_local project=${projectId} scene=${scene.sceneNumber}`); continue; }
        const clip=path.join(dir,`scene-${scene.sceneNumber}.mp4`); const audioLocal=String((scene.metadata as any)?.audioLocalPath||'');
        if(scene.assetType==='image/png' || audioLocal) await renderClip(local,clip,scene.duration||3,audioLocal && fs.existsSync(audioLocal) ? audioLocal : undefined); else { fs.copyFileSync(local,clip); } clips.push(clip);
      }
      if (clips.length === 0) throw new Error('No scene clips available for assembly');
      const assembled=path.join(dir,'final.mp4'); trace(`ffmpeg_assembly_start project=${projectId} clips=${clips.length}`); await concatClips(clips,assembled); trace(`ffmpeg_assembly_end project=${projectId}`);
      let finalUrl=assembled;
      if(r2Storage.isAvailable) {
        try { const uploaded=await r2Storage.uploadLocalFile(assembled,userId,'video-projects','video/mp4'); finalUrl=uploaded.url||assembled; }
        catch(r2Err:any) { trace(`r2_upload_failed project=${projectId} error=${r2Err.message}`); }
      }
      await db.update(schema.videoProjects).set({status:'completed',finalVideoUrl:finalUrl,updatedAt:new Date(),metadata:{sceneCount:complete.length,totalDuration:complete.reduce((a,s)=>a+(s.duration||0),0)}}).where(eq(schema.videoProjects.id,projectId)); trace(`project_complete project=${projectId}`);
    } catch(assemblyErr:any) {
      trace(`assembly_failed project=${projectId} error=${assemblyErr.message}`);
      await db.update(schema.videoProjects).set({status:'failed',metadata:{error:`Assembly: ${assemblyErr.message}`,sceneCount:complete.length},updatedAt:new Date()}).where(eq(schema.videoProjects.id,projectId));
    }
  }
  async processScene(scene:any,userId:string):Promise<void> {
    trace(`scene_start id=${scene.id} number=${scene.sceneNumber}`); await db.update(schema.videoScenes).set({status:'generating',updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));
    try { let localPath:string; let mime='video/mp4';
      if(scene.visualType==='still'){const result=await renderingEngine.renderImage(scene.visualPrompt); if(!result.success||!result.imageUrl)throw new Error(result.error||'GPT Image 2 failed'); localPath=result.imageUrl; mime='image/png';}
      else {const result=await soraVideoService.generateVideo(scene.visualPrompt,{userId:undefined}); if(!result.success||!result.videoPath)throw new Error(result.error||'Sora 2 failed'); localPath=result.videoPath;}
      let audioUrl:string|undefined; let audioLocalPath:string|undefined; if(scene.narration) { const audio = await this.generateAudio(scene.narration,userId,scene.id); audioUrl = audio.url; audioLocalPath = audio.localPath; }
      let assetUrl = localPath;
      if (r2Storage.isAvailable) { const copyPath = path.join(path.dirname(localPath), `${path.basename(localPath)}.r2-upload`); fs.copyFileSync(localPath, copyPath); const uploaded = await r2Storage.uploadLocalFile(copyPath, userId, 'video-scenes', mime); assetUrl = uploaded.url || localPath; }
      await db.update(schema.videoScenes).set({status:'completed',assetUrl,assetType:mime,audioUrl,metadata:{provider:scene.visualType==='still'?'gpt-image-2':'sora-2',localPath,audioLocalPath,narration:scene.narration},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id)); trace(`scene_complete id=${scene.id}`);
    } catch(error:any){trace(`scene_failed id=${scene.id} error=${error.message}`); await db.update(schema.videoScenes).set({status:'failed',metadata:{error:error.message},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));}
  }
  private async generateAudio(text:string,userId:string,sceneId:string):Promise<{url?:string;localPath:string}> {
    const key=process.env.OPENAI_API_KEY; const dir=path.join(process.cwd(),'temp','scene-audio'); fs.mkdirSync(dir,{recursive:true}); const localPath=path.join(dir,`${sceneId}.mp3`);
    if(!key) return {localPath};
    const response=await fetch('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-audio',voice:'alloy',input:text,response_format:'mp3'}),signal:AbortSignal.timeout(60000)});
    if(!response.ok) throw new Error(`GPT Audio ${response.status}`); fs.writeFileSync(localPath,Buffer.from(await response.arrayBuffer())); let url:string|undefined;
    if(r2Storage.isAvailable){const copyPath=`${localPath}.r2-upload`; fs.copyFileSync(localPath,copyPath); const up=await r2Storage.uploadLocalFile(copyPath,userId,'video-scenes/audio','audio/mpeg'); url=up.url;} return {url,localPath};
  }
  async getProject(projectId:string,userId:string) { const [project]=await db.select().from(schema.videoProjects).where(eq(schema.videoProjects.id,projectId)); if(!project||project.userId!==userId)return null; const scenes=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber)); const done=scenes.filter(s=>s.status==='completed').length; return {project,scenes,progress:scenes.length?Math.round(done/scenes.length*100):0}; }
  async regenerateScene(sceneId:string,userId:string) { const [scene]=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.id,sceneId)); if(!scene)return null; const project=await this.getProject(scene.projectId,userId); if(!project)return null; await this.processScene(scene,userId); await this.processProject(scene.projectId,userId,true); return scene.projectId; }
}
export const sceneVideoPipelineService = new SceneVideoPipelineService();
