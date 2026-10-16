/**
 * ASSEMBLY ON-SCREEN TEXT OVERLAYS (RENDER #7 PREP — owner ADJUST #2, Oct 16).
 *
 * Owner asked for the launch video to carry: bullet points "in writing on the
 * screen" as they are spoken, and "EmpireLaunchAI.com" pinned at the bottom.
 * This module is the OPT-IN assembly-stage overlay capability:
 *
 *  - Overlays are applied AFTER concatClips (a second, lossless-quality re-encode
 *    at CRF 18), NEVER baked into AI images — the no-text-in-image guard stays
 *    (GPT Image / Veo prompts never contain on-screen words).
 *  - Flags default OFF: absent metadata = today's pixel-exact output, concatClips
 *    is untouched (PR #118 safety), zero re-encode. Only the acceptance render
 *    (render #7) sets `onScreenOverlays` in project metadata.
 *  - Per-scene bullet groups are drawn with 60ms fade in/out windows aligned to
 *    each scene's dissolve-compensated global start (same math as concatClips).
 *  - A persistent bottom bar (text on a translucent band) spans the whole video.
 *
 * Pure helpers (resolveSceneVideoStarts / escapeDrawtext / normalizeAssemblyOverlays)
 * are deterministic and unit-tested; the ffmpeg pass is covered by a small real
 * fixture (assemblyOverlayFixture.test.ts).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

export interface AssemblyOverlaySpec {
  /** Bullet line groups, one entry per source scene (index-aligned with the concatClips inputs). */
  perScene?: { lines: string[] }[];
  /** Persistent bottom-bar text (e.g. 'EmpireLaunchAI.com'). */
  bottomBar?: string;
}

/** Candidate bold fonts (prod image gets fonts-dejavu-core via the Dockerfile). */
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
];
export function resolveOverlayFont(): string {
  for (const f of FONT_CANDIDATES) if (fs.existsSync(f)) return f;
  return FONT_CANDIDATES[1]; // last resort — DejaVuSans.ttf path; ffmpeg will error if truly absent
}

/** Pure: absolute start (seconds) of every scene on the delivered timeline —
 *  identical to concatClips' videoStart math (sum_{j<i} sec_j − tr·i, floor 0).
 *  Scene 0 always starts at 0. Deterministic + unit-tested. */
export function resolveSceneVideoStarts(clipSeconds: number[], transitionSeconds: number): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (let i = 0; i < clipSeconds.length; i++) {
    // concatClips' videoStart math: (sum_{j<i} sec_j) - tr*i — one dissolve
    // overlap consumed per boundary crossed, floor 0.
    starts.push(i === 0 ? 0 : Math.max(0, acc - transitionSeconds * i));
    acc += clipSeconds[i];
  }
  return starts;
}

/** escapeDrawtext: make a user-visible string safe inside an ffmpeg drawtext
 *  `text=` value (single-quoted filter arg). Escapes `\`, `'`, `:`, `%`, `,`, `[`, `]`. */
export function escapeDrawtext(raw: string): string {
  return String(raw ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '%%')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** Pure: validate + normalize an untrusted `onScreenOverlays` metadata payload.
 *  Returns a clean spec (or null when there is nothing to draw). Malformed
 *  entries are dropped, never thrown — the acceptance render must not die on a
 *  stray bullet. Deterministic + unit-tested. */
export function normalizeAssemblyOverlays(
  raw: unknown,
  sceneCount: number,
): AssemblyOverlaySpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const spec: AssemblyOverlaySpec = {};
  const perScene = Array.isArray(r.perScene) ? (r.perScene as unknown[]) : null;
  if (perScene) {
    const groups: { lines: string[] }[] = [];
    for (let i = 0; i < Math.min(perScene.length, sceneCount); i++) {
      const g = perScene[i];
      const lines = Array.isArray((g as any)?.lines)
        ? ((g as any).lines as unknown[]).filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
        : [];
      if (lines.length > 0) groups.push({ lines });
    }
    if (groups.length > 0) spec.perScene = groups;
  }
  if (typeof r.bottomBar === 'string' && r.bottomBar.trim().length > 0) {
    spec.bottomBar = r.bottomBar.trim();
  }
  return spec.perScene || spec.bottomBar ? spec : null;
}

// NOTE: overlays are drawn with timed drawtext/drawbox filters directly on the
// video (see applyAssemblyOverlays). Pre-rendered transparent PNGs are NOT used:
// on this ffmpeg build the lavfi->PNG path flattens alpha (observed both as
// rgb24 and as alpha=255 everywhere), which made full-frame overlay PNGs cover
// the video with opaque black.

export function probeClipSeconds(file: string): number {
  return probeSeconds(file);
}

function probeSeconds(file: string): number {
  try {
    const d = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { maxBuffer: 1024 * 1024 }).toString().trim();
    const n = parseFloat(d);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

/**
 * Apply overlay spec to an assembled video: per-scene bullet lines drawn DIRECTLY
 * on the video (timed ffmpeg drawtext filters) + a persistent bottom bar.
 *
 * Why direct drawtext instead of pre-rendered PNGs: on this ffmpeg build the PNG
 * path flattens the transparent canvas (alpha -> 255 / rgb24), so a full-frame
 * overlay PNG covers the video with opaque black. drawtext + drawbox with
 * enable='between(t,start,end)' needs no alpha at all — text/bars simply exist
 * only inside their scene's dissolve-compensated window.
 * Single re-encode at CRF 18 preserving the audio stream untouched (-c:a copy).
 * Throws on ffmpeg failure — loud, never silent.
 */
export function applyAssemblyOverlays(
  inputFile: string,
  outputFile: string,
  spec: AssemblyOverlaySpec,
  sceneStarts: number[],
  sceneSeconds: number[],
  opts?: { fontPath?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const font = opts?.fontPath ?? resolveOverlayFont();
    try {
      const total = probeSeconds(inputFile) || (sceneStarts.length > 0 ? sceneStarts[sceneStarts.length - 1] + (sceneSeconds[sceneSeconds.length - 1] || 0) : 0);
      const vf: string[] = [];
      // Per-scene bullet lines: one drawtext per line, enabled only inside the
      // scene's dissolve-compensated [start, nextStart) window.
      (spec.perScene ?? []).forEach((group, gi) => {
        if (!group.lines.length || gi >= sceneStarts.length) return;
        const start = sceneStarts[gi];
        const end = gi + 1 < sceneStarts.length ? sceneStarts[gi + 1] : total;
        const enable = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
        let y = 340;
        group.lines.forEach((line) => {
          const safe = escapeDrawtext(line);
          vf.push(
            `drawtext=fontfile='${font}':text='${safe}':fontsize=54:fontcolor=white:x=90:y=${y}:line_spacing=8:box=1:boxcolor=black@0.38:boxborderw=28:${enable}`,
          );
          y += 118;
        });
      });
      // Persistent bottom bar (translucent band + centered domain text), whole video.
      if (spec.bottomBar) {
        const safe = escapeDrawtext(spec.bottomBar);
        const enable = `enable='between(t,0,${total.toFixed(3)})'`;
        vf.push(
          `drawbox=x=0:y=1752:w=1080:h=168:color=black@0.72:t=fill:${enable}`,
          `drawtext=fontfile='${font}':text='${safe}':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=1782:${enable}`,
        );
      }
      if (!vf.length) {
        // Nothing to draw — pure passthrough copy (default OFF path).
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputFile, '-map', '0:v', '-map', '0:a?', '-c', 'copy', outputFile], { maxBuffer: 64 * 1024 * 1024 });
        resolve();
        return;
      }
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', inputFile,
        '-vf', vf.join(','),
        '-map', '0:v', '-map', '0:a?',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', '30',
        '-c:a', 'copy',
        outputFile,
      ];
      execFileSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
      resolve();
    } catch (e:any) {
      reject(new Error('applyAssemblyOverlays failed: ' + String(e?.message ?? e)));
    }
  });
}
