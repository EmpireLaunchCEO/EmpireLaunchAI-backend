/**
 * DIRECT-IMAGE STILL FIXTURE (RENDER #7 PREP — owner's real onboarding/pay
 * screenshots for scenes 1 + 5).
 *
 * Executes the real graph for a still scene whose (overridden) visualPrompt is a
 * DIRECT IMAGE URL: ensureLocalFile (the exact worker download call) -> renderClip
 * (Ken Burns/zoompan, the exact still-assembly path) -> concatClips ->
 * applyAssemblyOverlays (bullets + bottom bar), zero paid APIs, all against a local
 * HTTP server so the URL-fetch path is proven offline and deterministically.
 *
 * Asserts:
 *   - isDirectImageUrl discriminates (http image -> true; text prompt -> false;
 *     video URL -> false; empty -> false) — gpt-image is ONLY reachable behind the
 *     else of this predicate in processScene, so a true value means the renderer is
 *     never prompted for these scenes,
 *   - ensureLocalFile downloads the URL byte-exact (sha256 matches the source),
 *   - the assembled scene-1 window carries the source image luma (differs from the
 *     plain-bg control scene-2),
 *   - Ken Burns motion is real (frame t=0.6 vs t=2.4 differ),
 *   - overlays (scene-1 bullets + persistent EmpireLaunchAI.com bar) land on top,
 *   - duration ~5.2s and exactly ONE audio stream survive the whole path.
 *
 * Heavy-ish ffmpeg fixture — run STANDALONE (QA note: one at a time):
 *   npx tsx --test src/services/__tests__/directImageFixture.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderClip, concatClips, ensureLocalFile, isDirectImageUrl } from '../sceneVideoPipelineService.js';
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
function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
/** Mean luma of a crop [x,y,w,h] at time ss (single frame). */
function cropLuma(file: string, ss: number, x: number, y: number, w: number, h: number): { max: number; mean: number } {
  const raw = execFileSync(
    'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file, '-frames:v', '1',
      '-vf', `crop=${w}:${h}:${x}:${y}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 16 * 1024 * 1024 }
  );
  let sum = 0, max = 0;
  for (let i = 0; i < raw.length; i++) { const v = raw[i]; sum += v; if (v > max) max = v; }
  return { max, mean: sum / Math.max(1, raw.length) };
}
/** Full gray-frame bytes at time ss (to prove Ken Burns motion). */
function grayFrame(file: string, ss: number): Buffer {
  return execFileSync(
    'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(ss), '-i', file, '-frames:v', '1',
      '-vf', 'format=gray', '-f', 'rawvideo', '-'],
    { maxBuffer: 16 * 1024 * 1024 }
  );
}

test('direct image still: URL override flows pixel-exact through download -> Ken Burns -> assembly + overlays, renderer untouched', { skip: !HAS_FFMPEG }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dirimg-'));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(readFileSync(join(dir, 'src.png')));
  });
  try {
    // Source "screenshot" still: dark canvas + one large bright block (luma ~216) so
    // Ken Burns zoom really changes frame content (a flat field would be degenerate —
    // zooming a uniform color changes nothing to observe). The bright block sits at
    // x200-880 / y400-1520 — the crop asserted later (390,900,300,120) is inside it.
    ff(['-f', 'lavfi', '-i', 'color=c=0x404040:s=1080x1920',
        '-vf', 'drawbox=x=200:y=400:w=680:h=1120:color=0xD8D8D8:t=fill',
        '-frames:v', '1', join(dir, 'src.png')]);
    ff(['-f', 'lavfi', '-i', 'color=c=0x404040:s=1080x1920', '-frames:v', '1', join(dir, 'ctrl.png')]);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    const url = `http://127.0.0.1:${port}/scene1.png?x=${randomUUID().slice(0, 6)}`;

    // (0) Decision predicate — the renderer-untouched guarantee (renderImage sits in the else).
    assert.equal(isDirectImageUrl(url), true, 'http image URL -> direct-image path');
    assert.equal(isDirectImageUrl('  http://cdn.example.com/img.png  '), true, 'trimmed http image URL -> direct');
    assert.equal(isDirectImageUrl('Cinematic establishing shot, dark backdrops, no text'), false, 'text prompt stays on renderImage');
    assert.equal(isDirectImageUrl('https://cdn.example.com/clip.mp4?x=1'), false, 'video URL is NOT a direct still image');
    assert.equal(isDirectImageUrl(''), false, 'empty stays on renderImage path');
    assert.equal(isDirectImageUrl(undefined as any), false, 'undefined stays on renderImage path');

    // (1) Worker-side download: ensureLocalFile fetches the URL byte-exact.
    const local = await ensureLocalFile(url, 'fixture direct image');
    assert.equal(sha256(local), sha256(join(dir, 'src.png')), 'downloaded file is byte-identical to the served source');

    // (2) Ken Burns render of the downloaded still (the exact renderClip path).
    const t1 = join(dir, 't1.wav'); const t2 = join(dir, 't2.wav');
    ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5', '-c:a', 'pcm_s16le', t1]);
    ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=2.0', '-c:a', 'pcm_s16le', t2]);
    const c1 = join(dir, 'c1.mp4'); const c2 = join(dir, 'c2.mp4');
    await renderClip(local, c1, 3, t1, { kenburns: true, kenburnsStartZoom: 1.0, kenburnsEndZoom: 1.08, kenburnsDir: 'zoom-in' });
    await renderClip(join(dir, 'ctrl.png'), c2, 3, t2, { kenburns: true, kenburnsStartZoom: 1.05, kenburnsEndZoom: 1.12, kenburnsDir: 'zoom-in' });
    const dur1 = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', c1]));
    assert.ok(Number.isFinite(dur1) && Math.abs(dur1 - 3) < 0.25, `direct-image clip duration ${dur1}s ~= 3s`);
    const a1 = probe(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0', c1]).split('\n').filter((l) => l.trim() === 'audio');
    assert.equal(a1.length, 1, 'direct-image clip carries its narration audio');
    const fA = grayFrame(c1, 0.6); const fB = grayFrame(c1, 2.4);
    assert.ok(fA.equals(fB) === false, 'Ken Burns motion is real on the direct-image clip (frames differ)');

    // (3) Assembly WITH the plain-bg control: scene-1 window != scene-2 control luma.
    const plain = join(dir, 'plain.mp4');
    await concatClips([c1, c2], plain);
    const srcZone = cropLuma(plain, 1.0, 390, 900, 300, 120);
    const ctrlZone = cropLuma(plain, 3.6, 390, 900, 300, 120);
    assert.ok(srcZone.mean > 190, `scene-1 window carries the source image content (mean luma ${srcZone.mean}); plain control would sit ~64-128`);
    assert.ok(ctrlZone.mean < 150, `scene-2 window shows the plain control bg (mean luma ${ctrlZone.mean})`);
    assert.ok(srcZone.mean - ctrlZone.mean > 60, `source content clearly differs from control (Δ ${(srcZone.mean - ctrlZone.mean).toFixed(1)})`);

    // (4) Render-7 overlays on top of the direct-image still (bullets + bottom bar).
    const spec = normalizeAssemblyOverlays(
      { perScene: [{ lines: ['Introducing EmpireLaunch AI.', 'Your new go to platform.'] }, { lines: [] }], bottomBar: 'EmpireLaunchAI.com' },
      2,
    );
    assert.ok(spec, 'spec normalized');
    const seconds = [3, 3];
    const starts = resolveSceneVideoStarts(seconds, 0.8);
    const out = join(dir, 'final.mp4');
    await applyAssemblyOverlays(plain, out, spec!, starts, seconds);
    const bIn = cropLuma(out, 1.0, 60, 330, 960, 300);
    assert.ok(bIn.max > 190, `bullet text present over the direct-image still in scene 1 (max ${bIn.max})`);
    const bOut = cropLuma(out, 3.6, 60, 330, 960, 300);
    assert.ok(bOut.max < 150, `bullet zone clean in scene 2 (max ${bOut.max})`);
    const bar1 = cropLuma(out, 1.0, 320, 1796, 440, 60);
    const bar2 = cropLuma(out, 3.6, 320, 1796, 440, 60);
    assert.ok(bar1.max > 170 && bar2.max > 170, `bottom bar persistent in BOTH scenes (${bar1.max} / ${bar2.max})`);
    const durFin = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]));
    assert.ok(Number.isFinite(durFin) && Math.abs(durFin - 5.2) < 0.4, `overlaid final duration ${durFin}s ~= 5.2s planned`);
    const audioStreams = probe(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]).split('\n').filter((l) => l.trim() === 'audio');
    assert.equal(audioStreams.length, 1, 'exactly one audio stream survives');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});