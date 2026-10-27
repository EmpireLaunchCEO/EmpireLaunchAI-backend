/**
 * BOTTOM-FLASH OVERLAY — the ONE heavy FFmpeg fixture for this change set
 * (3.9GB RAM sandbox: heavy fixtures run one at a time). Executes the REAL
 * draw branch of applyAssemblyOverlays (assemblyOverlays.ts:382 — the
 * position==='bottom' flash) against a real 1080x1920 clip and proves with
 * per-frame luminance that the deliverable is a DARK translucENT NAVY band
 * at the bottom with gently pulsing domain text — NOT the pre-fix full-frame
 * white end card (assemblyOverlays.ts:249 normalizes position; requestedVisuals.ts:278
 * derives position:'bottom' for owner-dictated end flashes — owner Oct 26,
 * live faceless af053a01: "I want EmpireLaunchAi.com to be flashing at the
 * bottom of the screen").
 *
 * Discriminator: in the final flash window (t=1.6..2.0s) the bottom-flash
 * render must be DARK (mean luma well under the white-card level of ~250)
 * and meaningfully darker than the legacy centered card drawn on the same
 * clip — pre-fix code has no 'bottom' branch and renders the white card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAssemblyOverlays, normalizeAssemblyOverlays, probeClipSeconds } from '../assemblyOverlays.js';

function meanYavg(file: string, ss: string): number {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-ss', ss, '-i', file, '-vf', 'signalstats,metadata=print', '-frames:v', '1', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const m = /YAVG=([\d.]+)/.exec(r.stderr || '');
  assert.ok(m, `signalstats failed to emit YAVG for ${file}`);
  return Number(m[1]);
}

test('bottom flash renders a dark navy band, not the full-frame white end card', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ela-bottomflash-'));
  const clip = join(dir, 'clip.mp4');
  const outBottom = join(dir, 'bottom.mp4');
  const outCenter = join(dir, 'center.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=black:size=1080x1920:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
  ]);
  const bottomSpec = normalizeAssemblyOverlays(
    { flash: { text: 'EmpireLaunchAi.com', durationSec: 0.8, position: 'bottom', repeat: 3 } } as Record<string, unknown>,
    1,
  );
  assert.ok(bottomSpec);
  await applyAssemblyOverlays(clip, outBottom, bottomSpec, [0], [2]);
  const centerSpec = normalizeAssemblyOverlays(
    { flash: { text: 'EmpireLaunchAi.com', durationSec: 0.8 } } as Record<string, unknown>,
    1,
  );
  assert.ok(centerSpec);
  await applyAssemblyOverlays(clip, outCenter, centerSpec!, [0], [2]);

  for (const f of [outBottom, outCenter]) assert.equal(existsSync(f), true, `${f} missing`);
  const durB = probeClipSeconds(outBottom);
  const durC = probeClipSeconds(outCenter);
  assert.ok(Math.abs(durB - 2) < 0.15, `bottom-flash duration ${durB}`);
  assert.ok(Math.abs(durC - 2) < 0.15, `center duration ${durC}`);

  const yBottom = meanYavg(outBottom, '1.6');
  const yCenter = meanYavg(outCenter, '1.6');
  // Discriminators: bottom = translucent dark band (low luma), center = white card (~250).
  assert.ok(yBottom < 150, `bottom-flash window mean luma ${yBottom} — must NOT be the white card`);
  assert.ok(yCenter > 200, `legacy center card mean luma ${yCenter} — sanity check on the discriminator`);
  assert.ok(yCenter - yBottom > 80, `bottom (${yBottom}) must be meaningfully darker than center (${yCenter})`);
});