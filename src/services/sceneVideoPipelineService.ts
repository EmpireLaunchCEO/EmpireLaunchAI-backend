import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import { eq, asc, and, inArray, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { soraVideoService } from './soraVideoService.js';
import { renderingEngine } from './renderingEngine.js';
import { aiRouter } from './aiRouter.js';
import { r2Storage } from './r2StorageService.js';
export interface SceneScript { sceneNumber: number; duration: number; visualType: 'motion'|'still'; narration: string; visualPrompt: string; }
export interface VideoProjectInput { userId: string; title: string; idea: string; platforms?: string[]; style?: string; durationTarget?: number; script?: any; }
/** Sora 2 intermittently reports status:failed ~55-90s into generation. Scene motion
 *  scenes retry up to 2 extra attempts with short backoff (mirrors the single-shot
 *  Customize Video worker in videoQueueService.ts). Worst case: 3 × ~90s + 25s backoff
 *  ≈ 5 min, inside the 7-min per-scene deadline. */
const SCENE_SORA_MAX_ATTEMPTS = 3; // initial + 2 automatic retries
const SCENE_SORA_RETRY_BACKOFF_MS = [0, 10_000, 15_000]; // backoff before attempts 1/2/3
function trace(message: string) { process.stderr.write(`[SCENE_PIPELINE] ${message}\n`); }
/** Railway-safe deadline: ticks every 5s (no long setTimeout) and rejects after ms. */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const started = Date.now();
    let done = false;
    const timer = setInterval(() => {
      if (done) { clearInterval(timer); return; }
      if (Date.now() - started >= ms) {
        done = true;
        clearInterval(timer);
        reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
      }
    }, 5000);
    promise.then(
      (v) => { if (!done) { done = true; clearInterval(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearInterval(timer); reject(e); } },
    );
  });
}
function renderClip(input: string, output: string, duration: number, audio?: string): Promise<void> {
  return new Promise((resolve,reject)=>{
    // Explicit arg order is load-bearing: for a still image we need `-loop 1` IMMEDIATELY before `-i image.png`.
    // fluent-ffmpeg's .loop() misplaces `-loop 1` when a 2nd input (narration .wav) is added -> "Option loop not found".
    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(input);
    const args: string[] = [];
    if (isImage) args.push('-loop','1','-i',input);
    else args.push('-i',input);
    if (audio) args.push('-i',audio);
    args.push('-map','0:v:0');
    if (audio) args.push('-map','1:a:0','-shortest');
    args.push('-vf','scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2');
    args.push('-t',String(duration));
    args.push('-c:v','libx264','-pix_fmt','yuv420p');
    if (audio) args.push('-c:a','aac');
    args.push('-y',output);
    execFile('ffmpeg',args,{maxBuffer:32*1024*1024},(err,_stdout,stderr)=>{
      if(err) reject(new Error('ffmpeg exited with code '+(err.code??'')+': '+String(stderr||err.message).split('\n').filter(Boolean).slice(-3).join(' ')));
      else resolve();
    });
  });
}
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
    if (!skipGeneration) {
      // Never let a provider call leave a scene in `generating` forever. Railway can
      // keep an outbound request alive longer than the handler; enforce a deadline at
      // the worker boundary (7 min per scene — image gen up to 3 min + gpt-audio +
      // R2 uploads observed at ~5.5 min for still+narration; Sora polls up to ~5 min).
      const outcomes = await Promise.allSettled(scenes.map(scene => withDeadline(
        this.processScene(scene, userId),
        7 * 60 * 1000,
        `Scene ${scene.sceneNumber}`,
      )));
      const rejected = outcomes.filter(o => o.status === 'rejected').length;
      if (rejected) {
        trace(`scene_queue_rejections project=${projectId} count=${rejected}`);
        // A timed-out provider call may still be in flight; persist a terminal state
        // now so polling can never report a permanently generating scene. Scope to
        // non-completed scenes only — never clobber a scene that already finished.
        await db.update(schema.videoScenes).set({
          status: 'failed',
          metadata: { error: 'Scene generation timed out after 7 minutes' },
          updatedAt: new Date(),
        }).where(and(
          eq(schema.videoScenes.projectId, projectId),
          or(
            eq(schema.videoScenes.status, 'generating'),
            eq(schema.videoScenes.status, 'pending'),
          ),
        ));
      }
    }
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
      // ── Deliver to Operations page: mirror single-shot path — create a `creations`
      //    row (type 'video', status 'completed') so the project's final video shows up in
      //    GET /api/studio/assets AND an approvals row so it appears in the approval feed.
      //    Scene projects previously wrote ONLY to video_projects/video_scenes, so completed
      //    videos never surfaced on the Operations page. (Owner: "delivered to Operations page".)
      try {
        const creationId = uuidv4();
        const projectRow = projectId;
        let projectTitle = 'Scene-Based Video';
        try {
          const [pRow] = await db.select({ title: schema.videoProjects.title }).from(schema.videoProjects).where(eq(schema.videoProjects.id, projectId));
          if (pRow?.title) projectTitle = pRow.title;
        } catch {}
        await db.insert(schema.creations).values({
          id: creationId,
          userId,
          type: 'video',
          title: projectTitle,
          status: 'completed',
          fileUrl: finalUrl,
          metadata: { source: 'scene-based-video', projectId: projectRow, mode: 'scene', provider: 'ffmpeg' },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        trace(`project_library_creation project=${projectId} creation=${creationId}`);
        try {
          await db.insert(schema.approvals).values({
            id: uuidv4(),
            userId,
            type: 'video',
            status: 'completed',
            payload: { assetId: creationId, title: projectTitle, videoUrl: finalUrl, platforms: [], status: 'completed' },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } catch (apprErr: any) { trace(`scene_approval_insert_failed project=${projectId} err=${apprErr?.message}`); }
      } catch (libErr: any) {
        // Library/approval persistence must never fail the pipeline — log and continue.
        trace(`scene_library_insert_failed project=${projectId} err=${libErr?.message}`);
      }
    } catch(assemblyErr:any) {
      trace(`assembly_failed project=${projectId} error=${assemblyErr.message}`);
      await db.update(schema.videoProjects).set({status:'failed',metadata:{error:`Assembly: ${assemblyErr.message}`,sceneCount:complete.length},updatedAt:new Date()}).where(eq(schema.videoProjects.id,projectId));
    }
  }
  async processScene(scene:any,userId:string):Promise<void> {
    trace(`scene_start id=${scene.id} number=${scene.sceneNumber}`); await db.update(schema.videoScenes).set({status:'generating',updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));
    try { let localPath:string; let mime='video/mp4';
      if(scene.visualType==='still'){const result=await renderingEngine.renderImage(scene.visualPrompt); if(!result.success||!result.imageUrl)throw new Error(result.error||'GPT Image 2 failed'); localPath=result.imageUrl; mime='image/png';}
      else {
        // Motion scenes: Sora 2 flakes ~50% (status:failed ~55-90s in). Retry with backoff.
        let soraResult: { success: boolean; videoPath?: string; error?: string } | null = null;
        let retriesUsed = 0;
        for (let attempt = 1; attempt <= SCENE_SORA_MAX_ATTEMPTS; attempt++) {
          if (attempt > 1) {
            retriesUsed = attempt - 1;
            const backoffMs = SCENE_SORA_RETRY_BACKOFF_MS[attempt - 1] || 10_000;
            trace(`scene_sora_retry_${retriesUsed} id=${scene.id} attempt=${attempt}/${SCENE_SORA_MAX_ATTEMPTS} backoff=${backoffMs}ms`);
            await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
          }
          soraResult = await soraVideoService.generateVideo(scene.visualPrompt, { userId: undefined });
          if (soraResult.success && soraResult.videoPath) break;
          trace(`scene_sora_attempt_failed id=${scene.id} attempt=${attempt} error=${soraResult.error || 'no video path'}`);
        }
        if (!soraResult?.success || !soraResult.videoPath) throw new Error(soraResult?.error || 'Sora 2 failed');
        localPath = soraResult.videoPath;
      }
      let audioUrl:string|undefined; let audioLocalPath:string|undefined; if(scene.narration) { try { const audio = await this.generateAudio(scene.narration,userId,scene.id); audioUrl = audio.url; audioLocalPath = audio.localPath; } catch(audioErr:any) { trace(`scene_audio_failed id=${scene.id} error=${audioErr.message}`); } }
      let assetUrl = localPath;
      if (r2Storage.isAvailable) { const copyPath = path.join(path.dirname(localPath), `${path.basename(localPath)}.r2-upload`); fs.copyFileSync(localPath, copyPath); const uploaded = await r2Storage.uploadLocalFile(copyPath, userId, 'video-scenes', mime); assetUrl = uploaded.url || localPath; }
      await db.update(schema.videoScenes).set({status:'completed',assetUrl,assetType:mime,audioUrl,metadata:{provider:scene.visualType==='still'?'gpt-image-2':'sora-2',localPath,audioLocalPath,narration:scene.narration,audioProvider:audioUrl?'gpt-audio':undefined},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id)); trace(`scene_complete id=${scene.id}`);
    } catch(error:any){trace(`scene_failed id=${scene.id} error=${error.message}`); await db.update(schema.videoScenes).set({status:'failed',metadata:{error:error.message},updatedAt:new Date()}).where(eq(schema.videoScenes.id,scene.id));}
  }
  private async generateAudio(text:string,userId:string,sceneId:string):Promise<{url?:string;localPath:string}> {
    const key=process.env.OPENAI_API_KEY; const dir=path.join(process.cwd(),'temp','scene-audio'); fs.mkdirSync(dir,{recursive:true});
    if(!key) return {localPath:path.join(dir,`${sceneId}.mp3`)};
    const uploadAudio=async(lp:string,mime:string):Promise<string|undefined>=>{ if(!r2Storage.isAvailable) return undefined; try{ await fs.promises.copyFile(lp,`${lp}.r2-upload`); const up=await r2Storage.uploadLocalFile(`${lp}.r2-upload`,userId,'video-scenes/audio',mime); return up.url; }catch{ return undefined; } };
    // ---- Attempt 1: gpt-audio (owner's explicitly-enabled model) via Chat Completions ----
    // gpt-audio does NOT map to /v1/audio/speech (404 "Invalid URL"). It is an audio
    // chat model: POST /v1/chat/completions with modalities:['text','audio'] + audio:{voice,format}.
    // Returns message.audio.data as base64 WAV. Verified 200 in prod ownership checks.
    try {
      const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-audio',modalities:['text','audio'],audio:{voice:'alloy',format:'wav'},messages:[{role:'user',content:text}]}),signal:AbortSignal.timeout(90000)});
      if(r.ok){ const j=await r.json(); const aud=j?.choices?.[0]?.message?.audio; if(aud&&aud.data){ const buf=Buffer.from(aud.data as string,'base64'); if(buf.length>0){ const lp=path.join(dir,`${sceneId}.wav`); fs.writeFileSync(lp,buf); trace(`scene_audio_model_ok model=gpt-audio sceneId=${sceneId}`); const url=await uploadAudio(lp,'audio/wav'); return {url,localPath:lp}; } } trace(`scene_audio_model_failed model=gpt-audio status=no_audio sceneId=${sceneId}`); } else { trace(`scene_audio_model_failed model=gpt-audio status=${r.status} sceneId=${sceneId}`); }
    } catch(e:any){ trace(`scene_audio_gptaudio_err sceneId=${sceneId} err=${e?.message}`); }
    // ---- Attempt 2: classic TTS speech chain (/v1/audio/speech -> mp3) ----
    const localPath=path.join(dir,`${sceneId}.mp3`);
    const ttsModels=['gpt-4o-mini-tts','tts-1','tts-1-hd'];
    let response:Response|null=null; let lastStatus=0;
    for(const model of ttsModels){
      response=await fetch('https://api.openai.com/v1/audio/speech',{method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,voice:'alloy',input:text,response_format:'mp3'}),signal:AbortSignal.timeout(60000)});
      if(response.ok) break; lastStatus=response.status; trace(`scene_audio_model_failed model=${model} status=${response.status} sceneId=${sceneId}`);
    }
    if(!response||!response.ok) throw new Error(`GPT Audio ${lastStatus}`); fs.writeFileSync(localPath,Buffer.from(await response.arrayBuffer())); let url:string|undefined;
    if(r2Storage.isAvailable){const copyPath=`${localPath}.r2-upload`; fs.copyFileSync(localPath,copyPath); const up=await r2Storage.uploadLocalFile(copyPath,userId,'video-scenes/audio','audio/mpeg'); url=up.url;} return {url,localPath};
  }
  async getProject(projectId:string,userId:string) { const [project]=await db.select().from(schema.videoProjects).where(eq(schema.videoProjects.id,projectId)); if(!project||project.userId!==userId)return null; const scenes=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId,projectId)).orderBy(asc(schema.videoScenes.sceneNumber)); const done=scenes.filter(s=>s.status==='completed').length; return {project,scenes,progress:scenes.length?Math.round(done/scenes.length*100):0}; }
  async regenerateScene(sceneId:string,userId:string) { const [scene]=await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.id,sceneId)); if(!scene)return null; const project=await this.getProject(scene.projectId,userId); if(!project)return null; await this.processScene(scene,userId); await this.processProject(scene.projectId,userId,true); return scene.projectId; }
  /**
   * Resume-on-boot recovery. If the Railway process restarts (deploy, crash, scale),
   * fire-and-forget scene work dies with it and projects can sit in `generating` /
   * `assembling` forever. On boot (and periodically) mark those as failed so the UI
   * always resolves to a terminal state. Cheap + deterministic — we don't try to
   * resume mid-flight work, since the provider requests were killed with the process.
   */
  async recoverStaleProjects(minAgeMs = 0): Promise<number> {
    const candidates = await db.select().from(schema.videoProjects).where(or(
      eq(schema.videoProjects.status, 'generating'),
      eq(schema.videoProjects.status, 'assembling'),
    ));
    if (candidates.length === 0) return 0;
    let stale = candidates;
    if (minAgeMs > 0) {
      // Periodic tick: only fail projects that have been idle for the grace period.
      // A healthy pipeline bumps scene/project updatedAt as scenes start/complete, so
      // anything younger than the cutoff is actively being worked — never fail it
      // (observed false positive: still+narration scene legitimately runs ~5.5 min,
      // the 5-min tick killed it 9ms after scene_complete).
      const cutoff = new Date(Date.now() - minAgeMs);
      const fresh: typeof candidates = [];
      stale = [];
      for (const p of candidates) {
        const scenes = await db.select().from(schema.videoScenes).where(eq(schema.videoScenes.projectId, p.id));
        const lastActivity = scenes.reduce((max: Date, s: any) => (s.updatedAt > max ? s.updatedAt : max), p.updatedAt);
        if (lastActivity >= cutoff) fresh.push(p); else stale.push(p);
      }
      trace(`watchdog_aged candidates=${candidates.length} fresh=${fresh.length} stale=${stale.length}`);
    }
    if (stale.length === 0) return 0;
    const ids = stale.map((p: any) => p.id);
    await db.update(schema.videoProjects).set({
      status: 'failed',
      metadata: { error: 'Pipeline interrupted by service restart — regenerate this video', recoveredBy: 'resume-on-boot' },
      updatedAt: new Date(),
    }).where(inArray(schema.videoProjects.id, ids));
    // Also fail any scene still stuck in generating/pending so per-scene UI reflects it.
    await db.update(schema.videoScenes).set({
      status: 'failed',
      metadata: { error: 'Scene interrupted by service restart' },
      updatedAt: new Date(),
    }).where(and(
      inArray(schema.videoScenes.projectId, ids),
      or(
        eq(schema.videoScenes.status, 'generating'),
        eq(schema.videoScenes.status, 'pending'),
      ),
    ));
    trace(`recovered_stale_projects count=${stale.length} ids=${ids.map(i=>i.slice(0,8)).join(',')}`);
    return stale.length;
  }
  private watchdogStarted = false;
  /** Start the periodic stale-project watchdog (Railway-safe: setInterval, no long setTimeout).
   *  Boot run fails everything stranded (process just restarted — nothing can be actively
   *  working). Periodic ticks use an age grace so a healthy in-flight pipeline is never killed. */
  startWatchdog(intervalMs = 5 * 60 * 1000, staleGraceMs = 9 * 60 * 1000): void {
    if (this.watchdogStarted) return;
    this.watchdogStarted = true;
    // Run once immediately after boot, then on the interval.
    this.recoverStaleProjects().catch(e => trace(`watchdog_initial_failed error=${e.message}`));
    setInterval(() => {
      this.recoverStaleProjects(staleGraceMs).catch(e => trace(`watchdog_tick_failed error=${e.message}`));
    }, intervalMs);
    trace(`watchdog_started interval=${intervalMs}ms grace=${staleGraceMs}ms`);
  }
}
export const sceneVideoPipelineService = new SceneVideoPipelineService();
