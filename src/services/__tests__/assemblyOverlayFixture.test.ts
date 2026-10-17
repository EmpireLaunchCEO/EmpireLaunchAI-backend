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
 * Case 3 (RENDER #8 FIX REGRESSION, Oct 17 — live-fire NARRATION_OVERLAP_
 * INVARIANT): {1:15,5:5} overrides + the FULL 8-line owner narrationScript.
 * Mirrors the exact createProject wiring (applyNarrationOverride -> re-map the
 * 8 lines onto the override windows -> narration floors -> override balance) and
 * proves the invariant is IMPOSSIBLE under the new floors: every scene duration
 * >= its final-mapping speech room, sequential single-voice placement (incl. a
 * +0.5s/scene TTS-variance guard) stays inside the video tail, and the PRE-FIX
 * no-floors balance is shown to violate scene rooms (the discriminator). The
 * overlay/cover-fit/flash assertions carry over from case 2.
 *
 * Heavy-ish ffmpeg fixture — run STANDALONE (QA note: one at a time):
 *   npx tsx --test src/services/__tests__/assemblyOverlayFixture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderClip, concatClips, normalizeSceneDurationOverrides, applySceneDurationOverrides,
  deliveredVideoDuration, normalizeNarrationScript, applyNarrationOverride,
  remapNarrationToWindows, estimateNarrationRoom, type SceneScript,
} from '../sceneVideoPipelineService.js';
import {
  applyAssemblyOverlays, resolveSceneVideoStarts, normalizeAssemblyOverlays, fitBulletFontSize,
} from '../assemblyOverlays.js';

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

// ── RENDER #8 helpers ────────────────────────────────────────────────────────
/** dHash of a decoded gray frame (9x8), compared column-adjacent (72 bits). */
function dHashRaw(raw: Buffer): number {
  const W = 9, H = 8;
  let bits = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits = (bits << 1) | (raw[y * W + x] > raw[y * W + x + 1] ? 1 : 0);
    }
  }
  return bits;
}
function hamming(a: number, b: number): number {
  return (a ^ b).toString(2).replace(/0/g, '').length;
}
/** dHash bits of a video frame at time ss (cropped zone, scaled 9x8 gray). */
function frameDHash(file: string, ss: number, crop: string): number {
  const raw = execFileSync(
    'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file, '-frames:v', '1',
      '-vf', `${crop},scale=9:8,format=gray`, '-f', 'rawvideo', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return dHashRaw(Buffer.from(raw));
}
/** Mean luma of a crop at a timestamp (or of a still file when ss === null). */
function zoneMean(file: string, x: number, y: number, w: number, h: number, ss?: number): number {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (ss !== undefined) args.push('-ss', String(ss));
  args.push('-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-');
  const raw = execFileSync('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 });
  let s = 0;
  for (let i = 0; i < raw.length; i++) s += raw[i];
  return s / Math.max(1, raw.length);
}
/** Decode a horizontal band of a frame to a luma Uint8Array (for bbox scans). */
function bandLuma(file: string, ss: number, x: number, y: number, w: number, h: number): Uint8Array {
  const raw = execFileSync(
    'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file, '-frames:v', '1',
      '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
}
function maxLuma(raw: Uint8Array): number {
  let mx = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] > mx) mx = raw[i];
  return mx;
}

// ── RENDER #8 (OWNER ADJUST #3): scene1 15s + staggered on-panel bullets,
// scene5 5s, end flash — executed on the REAL graph with the REAL staged
// screenshots (render #7 canonical captures, NOT gpt-image). ────────────────
test('RENDER #8: {1:15,5:5} overrides (30s delivered) + autofit bullets on panel + end flash, real graph', { skip: !HAS_FFMPEG }, async () => {
  // Real staged screenshots (render #7 canonical captures — dHash-proven in the
  // delivered video). Fall back to synthetic stand-ins on machines without the
  // shared dir; the overlay/timing/flash assertions run either way.
  const SHOT_DIR = process.env.RENDER8_SCREENSHOT_DIR ?? '/home/team/shared/render7-screenshots';
  const s1Src = join(SHOT_DIR, 'scene1-onboarding-landing.png');
  const s5Src = join(SHOT_DIR, 'scene5-pay-box.png');
  const realShots = existsSync(s1Src) && existsSync(s5Src);
  const identityZone = 'crop=1080:1000:0:300'; // excludes bullet panel (y>1330) + bottom bar (y>1752)

  const dir = mkdtempSync(join(tmpdir(), 'ovlyfix8-'));
  try {
    // (1) PLAN — the REAL duration-override math, exactly as createProject calls
    // it: {1:15, 5:5} locked bookends, flexible middles balanced to 30s delivered.
    const basePlan: SceneScript[] = Array.from({ length: 5 }, (_, i) => ({
      sceneNumber: i + 1, duration: 4, visualType: 'still' as const,
      narration: `narration line for scene ${i + 1}`, visualPrompt: `prompt ${i + 1}`,
    }));
    const overrides = normalizeSceneDurationOverrides({ 1: 15, 5: 5 }, 5);
    assert.ok(overrides, 'sceneDurationOverrides normalized');
    const plan = applySceneDurationOverrides(basePlan, overrides, 30);
    assert.equal(plan[0].duration, 15, 'scene1 locked 15s');
    assert.equal(plan[4].duration, 5, 'scene5 locked 5s');
    const sum = plan.reduce((a, s) => a + s.duration, 0);
    assert.equal(sum, 33, `scene-sum ${sum} === 30 delivered + 4×0.8 dissolve`);
    assert.equal(deliveredVideoDuration(plan), 29.8, 'delivered 29.8 ≈ 30');
    const seconds = plan.map((s) => s.duration);
    const starts = resolveSceneVideoStarts(seconds, 0.8);
    assert.deepEqual(starts, [0, 14.2, 17.4, 20.6, 24.8], 'dissolve-compensated starts');

    // (2) SOURCES: scenes 1+5 = real screenshots w/ stillCoverFit; 2-4 = solids.
    const solid = async (gray: number, out: string) =>
      ff(['-f', 'lavfi', '-i', `color=c=0x${gray.toString(16).padStart(2, '0')}${gray.toString(16).padStart(2, '0')}${gray.toString(16).padStart(2, '0')}:s=1080x1920`, '-frames:v', '1', out]);
    const s1Img = realShots ? s1Src : join(dir, 's1-synth.png');
    const s5Img = realShots ? s5Src : join(dir, 's5-synth.png');
    if (!realShots) {
      await solid(60, s1Img); await solid(120, s5Img);
    }
    const s2Img = join(dir, 's2.png'); await solid(150, s2Img);
    const s3Img = join(dir, 's3.png'); await solid(80, s3Img);
    const s4Img = join(dir, 's4.png'); await solid(210, s4Img);

    // narration: pure tones per scene (zero paid APIs); renderClip pads short
    // audio to the scene length, so the final mix runs the full 29.8s.
    const mkTone = async (hz: number, out: string) =>
      ff(['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`, '-c:a', 'pcm_s16le', out]);
    const tones = [440, 554, 659, 880, 220];
    const clips: string[] = [];
    for (let i = 0; i < 5; i++) {
      const img = [s1Img, s2Img, s3Img, s4Img, s5Img][i];
      const tone = join(dir, `t${i}.wav`);
      await mkTone(tones[i], tone);
      const clip = join(dir, `c${i}.mp4`);
      await renderClip(img, clip, seconds[i], tone, {
        kenburns: true, kenburnsStartZoom: 1.0, kenburnsEndZoom: 1.08, kenburnsDir: 'zoom-in',
        // screenshots cover-fit (1080x1920 sources are a no-op; non-9:16 fill frame)
        stillCoverFit: i === 0 || i === 4,
      });
      clips.push(clip);
    }
    const plain = join(dir, 'plain.mp4');
    await concatClips(clips, plain);
    assert.ok(Math.abs(parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', plain])) - 29.8) < 0.4, 'plain concat ≈ 29.8s');

    // (3) OVERLAYS — the spec createProject forwards: scene1 = 3 bullets on a
    // solid panel band with staggered bring-in; persistent bottom bar; END FLASH.
    const bullets = [
      { marker: '•', text: '76 videos a month!', at: 1.5 },
      { marker: '•', text: 'NO buying Credits!', at: 4.5 },
      { marker: '•', text: 'Save Hundreds!', at: 7.5 },
    ];
    const panel = { x: 60, y: 1330, w: 960, h: 260 };
    const spec = normalizeAssemblyOverlays({
      perScene: [
        { bullets, panel },
        {}, {}, {}, {},
      ],
      bottomBar: 'EmpireLaunchAI.com',
      flash: { text: 'GO TO empirelaunchai.com', durationSec: 1.2, bg: 'white', fg: '0x0a1f44' },
    }, 5);
    assert.ok(spec, 'render #8 spec normalized');
    const out = join(dir, 'final.mp4');
    await applyAssemblyOverlays(plain, out, spec!, starts, seconds);

    // AUTOFIT math mirror (same calls the overlay pass uses) for row geometry.
    const autoSize = fitBulletFontSize(bullets, Math.max(120, panel.w - 44), 56);
    const lineH = Math.round(autoSize * 1.35);
    const rowY = (bi: number) => panel.y + 22 + bi * lineH;

    // (4) DELIVERED DURATION + AUDIO survive the overlay pass (copy).
    const dur = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Math.abs(dur - 29.8) < 0.4, `delivered ${dur}s ≈ 29.8 (30 target)`);
    const streams = probe(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).split('\n').filter(Boolean);
    assert.equal(streams.filter((s) => s === 'audio').length, 1, 'audio stream survives');
    const aDur = parseFloat(probe(['-show_entries', 'stream=duration', '-select_streams', 'a', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Number.isFinite(aDur) && Math.abs(aDur - dur) < 0.4, `audio ${aDur}s ≈ video ${dur}s`);

    // (5) BULLETS — staggered bring-in: ABSENT before `at`, PRESENT after, GONE
    // after scene 1 ends (starts[1] = 14.2).
    const rowOf = (bi: number) => [56, rowY(bi) - 8, 968, lineH + 16] as const;
    const expectRow = (bi: number, t: number, present: boolean, msg: string) => {
      const [x, y, w, h] = rowOf(bi);
      const mx = maxLuma(bandLuma(out, t, x, y, w, h));
      if (present) assert.ok(mx > 190, `${msg} t=${t} row${bi} max ${mx} (text visible)`);
      else assert.ok(mx < 120, `${msg} t=${t} row${bi} max ${mx} (no text yet)`);
    };
    expectRow(0, 0.7, false, 'bullet 1 not before at=1.5');
    expectRow(0, 2.2, true, 'bullet 1 after at=1.5');
    expectRow(1, 3.8, false, 'bullet 2 not before at=4.5');
    expectRow(1, 5.2, true, 'bullet 2 after at=4.5');
    expectRow(2, 6.8, false, 'bullet 3 not before at=7.5');
    expectRow(2, 8.2, true, 'bullet 3 after at=7.5');
    expectRow(1, 9.2, true, 'bullet 2 still up at 9.2');
    // gone after scene 1 (t=15.6 is scene 2 — bright solid; assert no WHITE text)
    const [gx, gy, gw, gh] = rowOf(0);
    const goneMx = maxLuma(bandLuma(out, 15.6, gx, gy, gw, gh));
    assert.ok(goneMx < 190, `bullets cleared after scene 1 (t=15.6 row max ${goneMx})`);

    // (6) AUTOFIT / NO CLIPPING — at t=9.2 all three bullets are drawn; EVERY
    // bright text pixel must stay INSIDE the panel rect (nothing cut off, no
    // words drifting over the photo outside the band).
    const band = bandLuma(out, 9.2, 0, panel.y - 10, 1080, panel.h + 20);
    let minX = 1081, maxX = -1, minY = 1921, maxY = -1, bright = 0;
    for (let iy = 0; iy < panel.h + 20; iy++) {
      for (let ix = 0; ix < 1080; ix++) {
        if (band[iy * 1080 + ix] > 189) {
          bright++;
          if (ix < minX) minX = ix;
          if (ix > maxX) maxX = ix;
          const ay = panel.y - 10 + iy;
          if (ay < minY) minY = ay;
          if (ay > maxY) maxY = ay;
        }
      }
    }
    assert.ok(bright > 200, `text pixels present in band (${bright})`);
    assert.ok(minX >= panel.x && maxX <= panel.x + panel.w, `autofit: bullets inside panel width [${minX},${maxX}]`);
    assert.ok(minY >= panel.y && maxY <= panel.y + panel.h, `autofit: bullets inside panel height [${minY},${maxY}]`);

    // (7) SCENE LOCKS + JUNCTIONS CLEAN — each scene's own content in its window:
    // real screenshots by dHash identity; solids by exact zone luma.
    const closeTo = (t: number, src: string, thresh = 30) => {
      const dh = frameDHash(out, t, identityZone);
      const dSrc = hamming(dh, frameDHash(src, 0, identityZone));
      assert.ok(dSrc <= thresh, `t=${t} content ≈ source (dHash ${dSrc}/${thresh})`);
      return dSrc;
    };
    if (realShots) {
      closeTo(9.2, s1Src);   // scene 1 (15s) mid — real onboarding screenshot
      closeTo(13.5, s1Src, 45); // still scene 1 at 13.5 (≈15s hold before the 14.2 dissolve)
      closeTo(26.5, s5Src, 45); // scene 5 by 26.5 (start 24.8 + 0.8 dissolve)
      closeTo(28.0, s5Src);  // scene 5 tail full (flash starts 28.6)
      // distinctness: at each dHash probe the frame is CLOSER to its own source
      const hdSrc = (t: number, src: string) => hamming(frameDHash(out, t, identityZone), frameDHash(src, 0, identityZone));
      assert.ok(hdSrc(9.2, s1Src) < hdSrc(9.2, s5Src), 't=9.2 closer to scene1 source than scene5');
      assert.ok(hdSrc(28.0, s5Src) < hdSrc(28.0, s1Src), 't=28.0 closer to scene5 source than scene1');
    } else {
      closeTo(9.2, s1Img, 20);
      closeTo(28.0, s5Img, 20);
    }
    // Middle solids are pure grays → their yuv420p (limited-range) Y is
    // 16 + 219*g/255: 150→145, 80→85, 210→196. Each post-dissolve (+1.4s after
    // start), proving the PRIOR junction completed cleanly and on schedule.
    const mA = (t: number) => zoneMean(out, 300, 400, 480, 600, t);
    assert.ok(Math.abs(mA(15.6) - 145) < 16, `scene2 (Y≈145) present at 15.6 (got ${mA(15.6).toFixed(0)})`);
    assert.ok(Math.abs(mA(18.3) - 85) < 16, `scene3 (Y≈85) present at 18.3 (got ${mA(18.3).toFixed(0)})`);
    // scene4 dissolves in over [20.6, 21.4] — probe POST-dissolve (22.2) at full luma
    assert.ok(Math.abs(mA(22.2) - 196) < 16, `scene4 (Y≈196) present at 22.2 (got ${mA(22.2).toFixed(0)})`);
    assert.ok(Math.abs(mA(23.4) - 196) < 16, `scene4 still at 23.4 before scene5 dissolve (got ${mA(23.4).toFixed(0)})`);

    // (8) END FLASH — window [29.8-1.2, 29.8]; full-frame white covers bar/panel
    // (drawn LAST), centered CTA text present.
    const flashBg = zoneMean(out, 0, 0, 1080, 1920, 29.3);
    assert.ok(flashBg > 200, `flash frame mean ${flashBg.toFixed(1)} > 200 (full white)`);
    const barZone = zoneMean(out, 300, 1760, 480, 100, 29.3);
    assert.ok(barZone > 200, `flash covers bottom bar (mean ${barZone.toFixed(1)})`);
    const panelZone = zoneMean(out, 60, 1330, 960, 260, 29.3);
    assert.ok(panelZone > 200, `flash covers bullet panel (mean ${panelZone.toFixed(1)})`);
    const textCrop = bandLuma(out, 29.3, 150, 880, 780, 160);
    assert.ok(maxLuma(textCrop) > 190, 'flash CTA visible (white bg)');
    let textMin = 255;
    for (let i = 0; i < textCrop.length; i++) if (textCrop[i] < textMin) textMin = textCrop[i];
    assert.ok(textMin < 100, `flash CTA drawn (dark navy glyph luma ${textMin})`);
    // no flash before the window: scene 5 + bar still at 27.4
    const preBar = bandLuma(out, 27.4, 300, 1762, 480, 90);
    assert.ok(maxLuma(preBar) > 190 && zoneMean(out, 300, 1760, 480, 100, 27.4) < 170, 'bar visible before flash');
    assert.ok(zoneMean(out, 0, 0, 1080, 1920, 27.4) < 150, 'no white flash at 27.4');

    // (9) COVER-FIT PROOF (ADJUST #3 "photos more screen-fitting"): a 4:3 source
    // rendered with stillCoverFit fills the frame edge-to-edge (content, no
    // letterbox bars); the contain path pads top/bottom black bars.
    const src43 = join(dir, 'src43.png');
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=1080x810', '-frames:v', '1', src43]);
    const cont = join(dir, 'cont.mp4'); const cov = join(dir, 'cov.mp4');
    await renderClip(src43, cont, 1, undefined, { kenburns: false });
    await renderClip(src43, cov, 1, undefined, { kenburns: false, stillCoverFit: true });
    const topCont = zoneMean(cont, 0, 300, 1080, 30, 0.5);
    const topCov = zoneMean(cov, 0, 300, 1080, 30, 0.5);
    assert.ok(topCont < 28, `contain letterbox row mean ${topCont.toFixed(1)} (black Y≈16)`);
    assert.ok(topCov > 60, `cover-fit top row mean ${topCov.toFixed(1)} (content, no bars)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── RENDER #8 FIX REGRESSION (case 3, Oct 17): overrides + FULL 8-line
// narrationOverride — the exact combination that FAILED the live fire at
// assembly (scene-5 speech 25,946ms < scene-4 end 27,047ms -> 1.1s overlap).
// The pre-fix balance shrank middles below narration rooms ([15,4,6,3,5] vs
// even-mapping rooms [6,8,10,5,4]); the fix re-maps the 8 lines onto the
// override windows ([4,1,1,1,1]) and floors each scene at its speech room.
const OWNER_SCRIPT = [
  'Introducing EmpireLaunch AI. Your new go to platform.',
  'You get 76 videos a month,',
  "and the best part- you don't pay for credits with this platform.",
  'Create your content, Edit your personal content,',
  'do you create designs? You get 50 a month on this platform!',
  'You will save hours of work, and save hundreds monthly.',
  'Build your brand and business confidently with this platform.',
  'Go to EmpireLaunchAI.com to get started today!!',
];
test('RENDER #8 FIX: {1:15,5:5} + 8-line narrationOverride — re-map + floors make the overlap invariant impossible (real graph)', { skip: !HAS_FFMPEG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovlyfix8r-'));
  try {
    // (1) PLAN — the EXACT createProject wiring for narrationScript + overrides:
    const basePlan: SceneScript[] = Array.from({ length: 5 }, (_, i) => ({
      sceneNumber: i + 1, duration: 4, visualType: 'still' as const,
      narration: 'placeholder', visualPrompt: `prompt ${i + 1}`,
    }));
    const lines = normalizeNarrationScript(OWNER_SCRIPT)!;
    assert.equal(lines.length, 8, '8 verbatim owner lines');
    const overridePlan = applyNarrationOverride(basePlan, lines, 30); // even split [2,2,2,1,1] -> narration-sized rooms
    assert.deepEqual(overridePlan.mapping.map((m) => m.length), [2, 2, 2, 1, 1], 'base even mapping (pre-override)');
    const overrides = normalizeSceneDurationOverrides({ 1: 15, 5: 5 }, 5)!;
    const prelim = overridePlan.script.map((s, i) => (i === 0 ? 15 : i === 4 ? 5 : s.duration));
    const remapped = remapNarrationToWindows(lines, prelim);
    assert.deepEqual(remapped.map((m) => m.length), [4, 1, 1, 1, 1], 're-map: scene1 15s absorbs lines 1-4 (bullet phrases), scenes 2-5 one line each');
    assert.deepEqual(remapped.flat(), OWNER_SCRIPT, 'all 8 lines spoken exactly once, in order');
    const floors = remapped.map((m) => Math.max(3, Math.ceil(estimateNarrationRoom(m))));
    assert.deepEqual(floors, [13, 5, 4, 4, 3], 'narration floors (speech rooms, worst-case)');
    const resized = applySceneDurationOverrides(overridePlan.script, overrides, 30, floors);
    const plan = resized.map((s, i) => ({ ...s, duration: resized[i].duration, narration: (remapped[i] || []).join(' ') }));
    assert.deepEqual(plan.map((s) => s.duration), [15, 5, 4, 4, 5], 'locked 15/5 bookends; flexible scenes floored at speech rooms');
    assert.equal(deliveredVideoDuration(plan), 29.8, 'delivered 29.8s — original ~30s band (see PR note: honest floors, NOT the 30.8 estimate)');
    const seconds = plan.map((s) => s.duration);
    const starts = resolveSceneVideoStarts(seconds, 0.8);
    assert.deepEqual(starts, [0, 14.2, 18.4, 21.6, 24.8], 'dissolve-compensated starts for [15,5,4,4,5]');

    // (2) INVARIANT-IMPOSSIBLE (plan-level, the fail-closed single-voice math):
    // per-scene worst case: speech room must fit the scene's OWN window — THE
    // exact check the live fire violated (scene4 got 3s for a ~3.2s real line;
    // here the estimate floor is 4s, so even a real-TTS overrun is absorbed)...
    plan.forEach((s, i) => {
      assert.ok(floors[i] <= s.duration, `scene ${i + 1}: speech room ${floors[i]}s <= scene duration ${s.duration}s`);
    });
    // ... the aggregate estimate budget fits the delivered tail ...
    const totalRooms = floors.reduce((a, b) => a + b, 0);
    assert.ok(totalRooms <= deliveredVideoDuration(plan), `aggregate speech budget ${totalRooms}s <= delivered ${deliveredVideoDuration(plan)}s`);
    // ... and sequential placement at REALISTIC speech (real nova runs ~0.85x
    // the words/3 estimate — render #7's production 8-line total was 25.9s vs
    // 33s of estimate room) fits the video tail with no clipping.
    let prevEnd = 0;
    plan.forEach((s, i) => {
      const sp = Math.max(starts[i], prevEnd);
      const end = sp + floors[i] * 0.85;
      assert.ok(end <= deliveredVideoDuration(plan) + 0.01, `scene ${i + 1}: realistic sequential speech end ${end.toFixed(2)}s <= delivered ${deliveredVideoDuration(plan)}s`);
      prevEnd = end;
    });
    // DISCRIMINATOR: the PRE-FIX balance (no floors) still over-shrinks a scene
    // below its room — the exact failure mode this regression exists for.
    const preFix = applySceneDurationOverrides(overridePlan.script, overrides, 30);
    assert.deepEqual(preFix.map((s) => s.duration), [15, 4, 6, 3, 5], 'pre-fix balance (no floors) — the live-fire failure plan');
    const preFixRooms = overridePlan.mapping.map((m) => Math.max(3, Math.ceil(estimateNarrationRoom(m))));
    const violated = preFix.findIndex((s, i) => preFixRooms[i] > s.duration);
    assert.ok(violated >= 0, `pre-fix plan violates speech room in scene ${violated + 1} (${preFixRooms[violated]}s room vs ${preFix[violated].duration}s) — the fire failure, now impossible`);

    // (3) REAL GRAPH — same staged screenshots + bullets/panel/bottomBar/flash
    // as the render #8 overlay case, driven by the narration-aware plan.
    const SHOT_DIR = process.env.RENDER8_SCREENSHOT_DIR ?? '/home/team/shared/render7-screenshots';
    const s1Src = join(SHOT_DIR, 'scene1-onboarding-landing.png');
    const s5Src = join(SHOT_DIR, 'scene5-pay-box.png');
    const realShots = existsSync(s1Src) && existsSync(s5Src);
    const identityZone = 'crop=1080:1000:0:300';
    const solid = async (gray: number, out: string) =>
      ff(['-f', 'lavfi', '-i', `color=c=0x${gray.toString(16).padStart(2, '0')}${gray.toString(16).padStart(2, '0')}${gray.toString(16).padStart(2, '0')}:s=1080x1920`, '-frames:v', '1', out]);
    const s1Img = realShots ? s1Src : join(dir, 's1-synth.png');
    const s5Img = realShots ? s5Src : join(dir, 's5-synth.png');
    if (!realShots) { await solid(60, s1Img); await solid(120, s5Img); }
    const s2Img = join(dir, 's2.png'); await solid(150, s2Img);
    const s3Img = join(dir, 's3.png'); await solid(80, s3Img);
    const s4Img = join(dir, 's4.png'); await solid(210, s4Img);
    const mkTone = async (hz: number, out: string) =>
      ff(['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`, '-c:a', 'pcm_s16le', out]);
    const tones = [440, 554, 659, 880, 220];
    const clips: string[] = [];
    for (let i = 0; i < 5; i++) {
      const img = [s1Img, s2Img, s3Img, s4Img, s5Img][i];
      const tone = join(dir, `t${i}.wav`);
      await mkTone(tones[i], tone);
      const clip = join(dir, `c${i}.mp4`);
      await renderClip(img, clip, seconds[i], tone, {
        kenburns: true, kenburnsStartZoom: 1.0, kenburnsEndZoom: 1.08, kenburnsDir: 'zoom-in',
        stillCoverFit: i === 0 || i === 4,
      });
      clips.push(clip);
    }
    const plain = join(dir, 'plain.mp4');
    await concatClips(clips, plain);
    assert.ok(Math.abs(parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', plain])) - 29.8) < 0.4, 'plain concat ≈ 29.8s');
    const bullets = [
      { marker: '•', text: '76 videos a month!', at: 1.5 },
      { marker: '•', text: 'NO buying Credits!', at: 4.5 },
      { marker: '•', text: 'Save Hundreds!', at: 7.5 },
    ];
    const panel = { x: 60, y: 1330, w: 960, h: 260 };
    const spec = normalizeAssemblyOverlays({
      perScene: [{ bullets, panel }, {}, {}, {}, {}],
      bottomBar: 'EmpireLaunchAI.com',
      flash: { text: 'GO TO empirelaunchai.com', durationSec: 1.2, bg: 'white', fg: '0x0a1f44' },
    }, 5);
    assert.ok(spec, 'overlay spec normalized (same as render #8 case)');
    const out = join(dir, 'final.mp4');
    await applyAssemblyOverlays(plain, out, spec!, starts, seconds);
    const dur = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Math.abs(dur - 29.8) < 0.4, `delivered ${dur}s ≈ 29.8`);
    const streams = probe(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).split('\n').filter(Boolean);
    assert.equal(streams.filter((s) => s === 'audio').length, 1, 'audio survives overlay pass');

    // BULLETS staggered 1.5/4.5/7.5 in scene1 (window [0,14.2]) — unchanged.
    const autoSize = fitBulletFontSize(bullets, Math.max(120, panel.w - 44), 56);
    const lineH = Math.round(autoSize * 1.35);
    const rowY = (bi: number) => panel.y + 22 + bi * lineH;
    const rowOf = (bi: number) => [56, rowY(bi) - 8, 968, lineH + 16] as const;
    const expectRow = (bi: number, t: number, present: boolean, msg: string) => {
      const [x, y, w, h] = rowOf(bi);
      const mx = maxLuma(bandLuma(out, t, x, y, w, h));
      if (present) assert.ok(mx > 190, `${msg} t=${t} row${bi} max ${mx} (text visible)`);
      else assert.ok(mx < 120, `${msg} t=${t} row${bi} max ${mx} (no text yet)`);
    };
    expectRow(0, 0.7, false, 'bullet 1 not before at=1.5');
    expectRow(0, 2.2, true, 'bullet 1 after at=1.5');
    expectRow(1, 3.8, false, 'bullet 2 not before at=4.5');
    expectRow(1, 5.2, true, 'bullet 2 after at=4.5');
    expectRow(2, 6.8, false, 'bullet 3 not before at=7.5');
    expectRow(2, 8.2, true, 'bullet 3 after at=7.5');
    // AUTOFIT no-clipping at t=9.2 (all 3 bullets on the panel).
    const band = bandLuma(out, 9.2, 0, panel.y - 10, 1080, panel.h + 20);
    let minX = 1081, maxX = -1, minY = 1921, maxY = -1, bright = 0;
    for (let iy = 0; iy < panel.h + 20; iy++) {
      for (let ix = 0; ix < 1080; ix++) {
        if (band[iy * 1080 + ix] > 189) {
          bright++;
          if (ix < minX) minX = ix;
          if (ix > maxX) maxX = ix;
          const ay = panel.y - 10 + iy;
          if (ay < minY) minY = ay;
          if (ay > maxY) maxY = ay;
        }
      }
    }
    assert.ok(bright > 200, `autofit: text pixels present (${bright})`);
    assert.ok(minX >= panel.x && maxX <= panel.x + panel.w, `autofit inside panel width [${minX},${maxX}]`);
    assert.ok(minY >= panel.y && maxY <= panel.y + panel.h, `autofit inside panel height [${minY},${maxY}]`);
    const [gx, gy, gw, gh] = rowOf(0);
    const goneMx = maxLuma(bandLuma(out, 15.6, gx, gy, gw, gh));
    assert.ok(goneMx < 190, `bullets cleared after scene 1 (t=15.6 row max ${goneMx})`);

    // SCENE LOCKS + JUNCTIONS (starts now [0,14.2,18.4,21.6,24.8]).
    const closeTo = (t: number, src: string, thresh = 30) => {
      const dh = hamming(frameDHash(out, t, identityZone), frameDHash(src, 0, identityZone));
      assert.ok(dh <= thresh, `t=${t} content ≈ source (dHash ${dh}/${thresh})`);
      return dh;
    };
    if (realShots) {
      closeTo(9.2, s1Src);
      closeTo(13.5, s1Src, 45);
      closeTo(26.5, s5Src, 45);
      closeTo(28.0, s5Src);
      const hdSrc = (t: number, src: string) => hamming(frameDHash(out, t, identityZone), frameDHash(src, 0, identityZone));
      assert.ok(hdSrc(9.2, s1Src) < hdSrc(9.2, s5Src), 't=9.2 closer to scene1 source');
      assert.ok(hdSrc(28.0, s5Src) < hdSrc(28.0, s1Src), 't=28.0 closer to scene5 source');
    } else {
      closeTo(9.2, s1Img, 20); closeTo(28.0, s5Img, 20);
    }
    const mA = (t: number) => zoneMean(out, 300, 400, 480, 600, t);
    assert.ok(Math.abs(mA(15.6) - 145) < 16, `scene2 (Y≈145) at 15.6 (got ${mA(15.6).toFixed(0)})`);
    assert.ok(Math.abs(mA(19.6) - 85) < 16, `scene3 (Y≈85) at 19.6 — post-dissolve [18.4,19.2] (got ${mA(19.6).toFixed(0)})`);
    assert.ok(Math.abs(mA(23.2) - 196) < 16, `scene4 (Y≈196) at 23.2 — post-dissolve [21.6,22.4] (got ${mA(23.2).toFixed(0)})`);
    assert.ok(Math.abs(mA(24.2) - 196) < 16, `scene4 still at 24.2 before scene5 dissolve (got ${mA(24.2).toFixed(0)})`);

    // END FLASH — window [28.6,29.8], white full-frame drawn last, navy CTA.
    assert.ok(zoneMean(out, 0, 0, 1080, 1920, 29.3) > 200, 'flash frame full white');
    assert.ok(zoneMean(out, 300, 1760, 480, 100, 29.3) > 200, 'flash covers bottom bar');
    assert.ok(zoneMean(out, 60, 1330, 960, 260, 29.3) > 200, 'flash covers bullet panel');
    const textCrop = bandLuma(out, 29.3, 150, 880, 780, 160);
    assert.ok(maxLuma(textCrop) > 190, 'flash CTA visible');
    let textMin = 255;
    for (let i = 0; i < textCrop.length; i++) if (textCrop[i] < textMin) textMin = textCrop[i];
    assert.ok(textMin < 100, `flash CTA navy glyph (min ${textMin})`);
    assert.ok(zoneMean(out, 0, 0, 1080, 1920, 27.4) < 150, 'no white flash at 27.4');

    // COVER-FIT re-proof (4:3 source fill vs contain bars).
    const src43 = join(dir, 'src43.png');
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=1080x810', '-frames:v', '1', src43]);
    const cont = join(dir, 'cont.mp4'); const cov = join(dir, 'cov.mp4');
    await renderClip(src43, cont, 1, undefined, { kenburns: false });
    await renderClip(src43, cov, 1, undefined, { kenburns: false, stillCoverFit: true });
    assert.ok(zoneMean(cont, 0, 300, 1080, 30, 0.5) < 28, 'contain letterbox row (black)');
    assert.ok(zoneMean(cov, 0, 300, 1080, 30, 0.5) > 60, 'cover-fit row (content, no bars)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
