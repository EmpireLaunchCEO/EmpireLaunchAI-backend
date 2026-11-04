/**
 * RENDER #5 PREP — TAIL-CLIP FIXTURE (REAL ffmpeg, zero paid APIs):
 * The owner's ADJUST is "video cut short at the end" — the FINAL scene's video
 * ended before the narration's last words finished. The fix (renderClip
 * padVideoToAudio + planner-sized narration rooms) must prove, on a delivered
 * MP4 assembled through the REAL graph (renderClip -> concatClips), that:
 *   (a) the final spoken audio survives to its natural end (probed speech end
 *       essentially equals the narration's true duration in the timeline), and
 *   (b) the video now covers the narration end (no more cut).
 * The old code cut the final audio to the scene duration — this fixture would
 * FAIL on it (speech end == scene end, not narration end).
 * FFmpeg is required; the test skips (not fails) when it is unavailable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderClip, concatClips } from '../sceneVideoPipelineService.js';

const HAS_FFMPEG = (() => {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0;
})();

function ff(args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync('ffmpeg', args, { encoding: 'utf8', maxBuffer }).toString();
}
function ffprobe(args: string[]): string {
  return execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).toString().trim();
}
function probeSeconds(file: string): number {
  const d = ffprobe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  return Number.isFinite(parseFloat(d)) ? parseFloat(d) : 0;
}
/** Where the final silence starts = where meaningful audio ENDS in the timeline. */
function lastNonSilenceSeconds(file: string): number {
  const out = ff(['-i', file, '-af', 'silencedetect=noise=-38dB:d=0.3', '-f', 'null', '-'], 16 * 1024 * 1024);
  // silence_start lines mark the beginning of each silence run — the LAST one is
  // where the final speech ended and silence took over.
  const starts = Array.from(out.matchAll(/silence_start: ([\d.]+)/g), m => parseFloat(m[1]));
  return starts.length ? Math.max(...starts) : probeSeconds(file);
}

test('tail clip: final-scene video is padded to the narration end (delivered MP4 proves no cut word)', { skip: !HAS_FFMPEG && 'ffmpeg unavailable' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailclip-'));
  try {
    const clipPaths: string[] = [];
    // 5 stills + audio; the FINAL narration is deliberately LONGER than its
    // scene duration (7.2s speech in a 6.0s scene) — the owner's cut-word case.
    for (let i = 1; i <= 5; i++) {
      const png = join(dir, `s${i}.png`);
      ff(['-y', '-f', 'lavfi', '-i', `color=c=0x${i % 2 ? '2255aa' : 'aa5522'}:s=1080x1920:d=1`, '-frames:v', '1', png]);
      const wav = join(dir, `a${i}.wav`);
      // final narration: 7.2s of clear tone (stands in for TTS speech end);
      // scenes 1-4: 2.2s (shorter than scene, never the cut case)
      const dur = i === 5 ? '7.2' : '2.2';
      ff(['-y', '-f', 'lavfi', '-i', `sine=frequency=${400 + i * 20}:duration=${dur}`, '-af', 'volume=0.4', wav]);
      const clip = join(dir, `clip${i}.mp4`);
      await renderClip(png, clip, 6, wav, i === 5
        ? { kenburns: true, kenburnsDir: 'zoom-in', padVideoToAudio: true }
        : { kenburns: true, kenburnsDir: 'zoom-in' });
      clipPaths.push(clip);
    }

    // Final-scene clip: video must now cover the full 7.2s narration
    const c5 = probeSeconds(clipPaths[4]);
    assert.ok(c5 >= 7.1, `final clip video ${c5}s < 7.1s — narration end clipped`);

    // Assemble through the REAL delivery graph
    const final = join(dir, 'final.mp4');
    await concatClips(clipPaths, final);
    const v = probeSeconds(final);
    // speech end in the delivered timeline: final clip start + its 7.2s narration
    const clipDurs = clipPaths.map(probeSeconds);
    const tr = 0.8;
    const finalStart = (clipDurs.slice(0, 4).reduce((a, b) => a + b, 0) - tr * 4);
    const expectedSpokenEnd = finalStart + 7.2;
    const spoken = lastNonSilenceSeconds(final);
    // (a) every spoken word survives: last non-silence reaches within 0.35s of
    // the narration's true end; the old code ended here at finalStart + 6.0 == 26.8
    assert.ok(spoken >= expectedSpokenEnd - 0.35,
      `speech ends at ${spoken.toFixed(2)}s; expected >= ${(expectedSpokenEnd - 0.35).toFixed(2)}s — final words cut`);
    assert.ok(spoken <= expectedSpokenEnd + 0.6,
      `speech ends at ${spoken.toFixed(2)}s; expected <= ${(expectedSpokenEnd + 0.6).toFixed(2)}s`);
    // (b) the delivered video never ends before the speech (cut-word failure mode)
    assert.ok(v >= expectedSpokenEnd - 0.1, `video ${v}s < spoken end ${expectedSpokenEnd.toFixed(2)}s`);
    // sanity: delivered length is not pathologically long (the 29.5-30.5s band is
    // the PLANNER's contract — proven by sizeScenesToNarration; this fixture only
    // proves the tail mechanics on the real graph)
    assert.ok(v <= 31, `delivered ${v}s too long`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});