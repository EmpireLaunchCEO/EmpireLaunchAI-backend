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
import path from 'path';
import os from 'os';

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

/** Render one scene's bullet group as a transparent 1080x1920 PNG. */
function renderBulletPng(lines: string[], font: string, dest: string): void {
  const filters: string[] = [];
  const X = 90;
  let y = 340;
  const LINE_H = 118;
  lines.forEach((line, i) => {
    const safe = escapeDrawtext(line);
    filters.push(
      `drawtext=fontfile='${font}':text='${safe}':fontsize=54:fontcolor=white:x=${X}:y=${y}:line_spacing=8:box=1:boxcolor=black@0.38:boxborderw=28`,
    );
    y += LINE_H;
  });
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black@0:s=1080x1920:r=1',
    '-frames:v', '1',
    '-vf', filters.join(','),
    dest,
  ], { maxBuffer: 32 * 1024 * 1024 });
}

/** Render the persistent bottom bar (translucent band + centered domain text). */
function renderBottomBarPng(text: string, font: string, dest: string): void {
  const safe = escapeDrawtext(text);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black@0:s=1080x1920:r=1',
    '-frames:v', '1',
    '-vf',
    `drawbox=x=0:y=1752:w=1080:h=168:color=black@0.72:t=fill,` +
    `drawtext=fontfile='${font}':text='${safe}':fontsize=60:fontcolor=white:x=(w-text_w)/2:y=1782`,
    dest,
  ], { maxBuffer: 32 * 1024 * 1024 });
}

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
 * Apply overlay spec to an assembled video: per-scene bullet PNGs (fade in/out
 * aligned to each scene's dissolve-compensated window) + a persistent bottom bar.
 * Single re-encode at CRF 18 (visually lossless) preserving the original audio
 * stream untouched (-c:a copy). Throws on ffmpeg failure — loud, never silent.
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovly-'));
    const inputs: string[] = [];
    const filter: string[] = [];
    try {
      const total = probeSeconds(inputFile) || (sceneStarts.length > 0 ? sceneStarts[sceneStarts.length - 1] + (sceneSeconds[sceneSeconds.length - 1] || 0) : 0);
      // Bullet strips (fade in 60ms after scene start, out 60ms before scene end / total end).
      const pngs: string[] = [];
      (spec.perScene ?? []).forEach((group, gi) => {
        if (!group.lines.length || gi >= sceneStarts.length) return;
        const png = path.join(dir, `bullets_${gi}.png`);
        renderBulletPng(group.lines, font, png);
        pngs.push(png);
        const start = sceneStarts[gi];
        const end = gi + 1 < sceneStarts.length ? sceneStarts[gi + 1] : total;
        const fadeIn = Math.min(0.06, Math.max(0.001, (sceneSeconds[gi] ?? 1) * 0.05));
        const fadeOut = Math.min(0.06, Math.max(0.001, (sceneSeconds[gi] ?? 1) * 0.05));
        const bIn = Math.max(0, start - fadeIn).toFixed(3);
        const bOut = Math.max(start + 0.05, end + fadeOut).toFixed(3);
        inputs.push('-i', png);
        filter.push(`[${inputs.length - 1}:v]format=rgba,fade=t=in:st=${bIn}:d=${fadeIn.toFixed(3)}:alpha=1,fade=t=out:st=${end.toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1[b${gi}]`);
      });
      // Persistent bottom bar.
      let barLabel = '';
      if (spec.bottomBar) {
        const barPng = path.join(dir, 'bottombar.png');
        renderBottomBarPng(spec.bottomBar, font, barPng);
        inputs.push('-i', barPng);
        inputs.push('-i', inputFile); // main video LAST so [0] indexing below stays stable
        const base = inputs.length - 1; // main video index (0-based, after pngs+main? we appended main last)
        // NOTE: main video is appended AFTER the pngs; its index = pngs.length + (bar?1:0).
        filter.push(`[${base}:v][${pngs.length}:v]overlay=0:0:format=auto[vbar]`);
        barLabel = `[vbar]`;
      } else {
        inputs.push('-i', inputFile);
        barLabel = `[${inputs.length - 1}:v]`;
      }
      // Import ordering safe-guard: build the concat chain over [b0..bN] then bar.
      let vid = barLabel;
      // overlay bullets onto the base video
      let acc = vid;
      for (let i = 0; i < pngs.length; i++) {
        const lbl = `[vx${i}]`;
        filter.push(`${acc}[b${i}]overlay=0:0:format=auto${lbl}`);
        acc = lbl;
      }
      const outLabel = acc;
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        ...inputs,
        '-filter_complex', filter.join(','),
        '-map', outLabel.replace(/^\[|\]$/g, ''),
        '-map', `${inputs.length - 1}:a?`,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', '30',
        '-c:a', 'copy',
        outputFile,
      ];
      execFileSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
      resolve();
    } catch (e:any) {
      reject(new Error('applyAssemblyOverlays failed: ' + String(e?.message ?? e)));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
}