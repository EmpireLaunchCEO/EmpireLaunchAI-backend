/**
 * ASSEMBLY OVERLAY FIXTURE (RENDER #7 PREP — REAL ffmpeg, zero paid APIs).
 *
 * Executes the real graph: renderClip (solid stills + pure-tone narration) ->
 * concatClips -> applyAssemblyOverlays with the owner's required elements:
 *   - per-scene bullet lines (scene 1 only here), windowed to that scene,
 *   - persistent bottom bar ("EmpireLaunchAI.com") spanning the WHOLE video.
 *
 * Asserts on the delivered MP4 by extracting luma crops:
 *   - bullet-zone text pixels present in scene 1's window, ABSENT afterwards,
 *   - bottom-bar text pixels present in BOTH scenes (persistent),
 *   - duration + audio stream survive the overlay pass (copy).
 *
 * Heavy-ish ffmpeg fixture — run STANDALONE (QA note: one at a time):
 *   npx tsx --test src/services/__tests__/assemblyOverlayFixture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderClip, concatClips } from '../sceneVideoPipelineService.js';
import { applyAssemblyOverlays, resolveSceneVideoStarts, normalizeAssemblyOverlays } from '../assemblyOverlays.js';

const HAS_FFMPEG = (() => {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0;
})();

function ff(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
}
function probe(args: string[]): string {
  return execFileSync('ffprobe', ['-v', 'error', ...args], { maxBuffer: 4 * 1024 * 1024 }).toString().trim();
}
/** Max + mean luma of a crop [x,y,w,h] at time ss (single frame). */
function cropLuma(file: string, ss: number, x: number, y: number, w: number, h: number): { max: number; mean: number } {
  const raw = execFileSync(
    'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file, '-frames:v', '1',
      '-vf', `crop=${w}:${h}:${x}:${y}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  let sum = 0, max = 0;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    sum += v;
    if (v > max) max = v;
  }
  return { max, mean: sum / Math.max(1, raw.length) };
}

// Heavy-ish ffmpeg fixture executing the REAL overlay graph (renderClip ->
// concatClips -> applyAssemblyOverlays) with zero paid APIs. Runs by default;
// skipped only when ffmpeg is unavailable on the host. Keep standalone-style
// runs (one heavy fixture at a time).
test('assembly overlays: scene-windowed bullets + persistent bottom bar on the real graph', { skip: !HAS_FFMPEG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovlyfix-'));
  try {
    const s1 = join(dir, 's1.png');
    const s2 = join(dir, 's2.png');
    // distinct mid-gray stills (luma ~128) so text pixels are unambiguous
    ff(['-f', 'lavfi', '-i', 'color=c=0x808080:s=1080x1920', '-frames:v', '1', s1]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x707070:s=1080x1920', '-frames:v', '1', s2]);
    const t1 = join(dir, 't1.wav');
    const t2 = join(dir, 't2.wav');
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5', '-c:a', 'pcm_s16le', t1]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2.0', '-c:a', 'pcm_s16le', t2]);
    const c1 = join(dir, 'c1.mp4');
    const c2 = join(dir, 'c2.mp4');
    await renderClip(s1, c1, 3, t1, { kenburns: true, kenburnsStartZoom: 1.0, kenburnsEndZoom: 1.08, kenburnsDir: 'zoom-in' });
    await renderClip(s2, c2, 3, t2, { kenburns: true, kenburnsStartZoom: 1.08, kenburnsEndZoom: 1.16, kenburnsDir: 'zoom-in' });
    const plain = join(dir, 'plain.mp4');
    await concatClips([c1, c2], plain);

    const spec = normalizeAssemblyOverlays(
      {
        // Discriminating text: line 2 carries an apostrophe + comma — the exact
        // case that BROKE the render #7 live fire (inline text='...\'...' splits
        // ffmpeg's filtergraph at the next enable='between(t,...' comma). Must
        // render via textfile=. The old inline text='...' path FAILS on this.
        perScene: [{ lines: ['Introducing EmpireLaunch AI.', "and the best part- you don't pay for credits with this platform."] }, { lines: [] }],
        bottomBar: 'EmpireLaunchAI.com',
      },
      2,
    );
    assert.ok(spec, 'spec normalized');
    const seconds = [3, 3];
    const starts = resolveSceneVideoStarts(seconds, 0.8);
    assert.deepEqual(starts, [0, 2.2], 'dissolve-compensated starts (3s scenes, 0.8s xfade)');
    const out = join(dir, 'final.mp4');
    await applyAssemblyOverlays(plain, out, spec!, starts, seconds);

    // duration + audio preserved through the overlay re-encode (audio copied)
    const dur = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Number.isFinite(dur) && Math.abs(dur - 5.2) < 0.4, `overlaid duration ${dur}s ≈ 5.2s planned`);
    const audioStreams = probe(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).split('\n').filter((l) => l.trim() === 'audio');
    assert.equal(audioStreams.length, 1, 'audio stream survives the overlay pass');

    // (1) BULLETS — scene 1 window (t=1.0): white text pixels in the bullet zone
    const bIn = cropLuma(out, 1.0, 60, 330, 960, 300);
    assert.ok(bIn.max > 190, `bullet text pixels present in scene 1 (max luma ${bIn.max})`);
    // (2) BULLETS GONE in scene 2 (t=3.6 after the 0.8s fade ends at 3.0): zone back to gray
    const bOut = cropLuma(out, 3.6, 60, 330, 960, 300);
    assert.ok(bOut.max < 150, `bullet zone clean in scene 2 (max luma ${bOut.max})`);
    // (3) BOTTOM BAR — persistent: text pixels in BOTH scenes (t=1.0 and t=3.6)
    const bar1 = cropLuma(out, 1.0, 320, 1796, 440, 60);
    const bar2 = cropLuma(out, 3.6, 320, 1796, 440, 60);
    assert.ok(bar1.max > 170, `bottom-bar text present in scene 1 (max ${bar1.max})`);
    assert.ok(bar2.max > 170, `bottom-bar text present in scene 2 (max ${bar2.max})`);
    // (4) CONTROL — same crops on the PLAIN video carry no text pixels
    const ctrlBar = cropLuma(plain, 1.0, 320, 1796, 440, 60);
    assert.ok(ctrlBar.max < 170, `plain video has no bottom-bar text (max ${ctrlBar.max})`);
    const ctrlBullets = cropLuma(plain, 1.0, 60, 330, 960, 300);
    assert.ok(ctrlBullets.max < 190, `plain video has no bullet text (max ${ctrlBullets.max})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});