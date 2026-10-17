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
import { tmpdir } from 'os';
import { join } from 'path';

/** One on-screen bullet: marker glyph + text + optional bring-in time (seconds
 *  after its scene's dissolve-compensated start). `at` default 0 — appears with
 *  the scene. Deterministic; malformed entries are dropped by the normalizer. */
export interface AssemblyBullet {
  text: string;
  /** seconds after the scene start when this bullet fades in (0 = with the scene) */
  at?: number;
  /** marker glyph prefix, e.g. '\u2022' (default none for backward-compat `lines`) */
  marker?: string;
}

/** Bullet PANEL spec (owner ADJUST #3: "bullets not words-over-photo"): a solid
 *  translucent dark band where bullet text lives, instead of floating over the
 *  photo's own words. Geometry clamped to the 1080x1920 frame. */
export interface AssemblyBulletPanel {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** drawbox fill color with alpha, e.g. 'black@0.85' */
  bg?: string;
}

/** End-flash spec (owner ADJUST #3: end flash "GO TO empirelaunchai.com"): a
 *  full-frame flash + centered bold text in the final `durationSec` of the video. */
export interface AssemblyEndFlash {
  text: string;
  /** flash window length at the very end (default 1.2s) */
  durationSec?: number;
  /** full-frame background color (default 'white') */
  bg?: string;
  /** text color (default navy) */
  fg?: string;
  /** base fontsize — autofit shrinks so the CTA always fits 1080px */
  fontSize?: number;
}

export interface AssemblyOverlaySpec {
  /** Bullet groups, one entry per source scene (index-aligned with the concatClips inputs). */
  perScene?: { lines?: string[]; bullets?: AssemblyBullet[]; panel?: AssemblyBulletPanel }[];
  /** Persistent bottom-bar text (e.g. 'EmpireLaunchAI.com'). */
  bottomBar?: string;
  /** End flash (render #8, owner ADJUST #3). */
  flash?: AssemblyEndFlash;
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

/**
 * AUTOFIT (owner ADJUST #3 — "wording fixed; nothing cut off"): estimate the
 * rendered pixel width of a string in DejaVu Sans Bold at a given fontsize and
 * shrink the fontsize so the LONGEST line (marker + text) fits `maxWidth`.
 *
 * Width model: DejaVu Sans Bold glyphs (measured): M=0.78em W=0.86em m=0.72em
 * w=0.68em; digits/uppercase ≈ 0.61em; lowercase ≈ 0.55em; space ≈ 0.28em;
 * thin chars (i l j I t f r 1 . , : ; ' " ! | ) ≈ 0.28em; '@' 0.78em.
 * The table below encodes the heavy + thin classes; everything else falls into
 * the middling defaults. The fit is conservative (true text_w is measured by
 * ffmpeg AFTER we pick the size — this is a deterministic pre-fit that keeps
 * the longest line inside the panel; the fixture proves no clipping).
 */
const CHAR_WIDTH_EM: Record<string, number> = {
  M: 0.84, W: 0.92, m: 0.78, w: 0.74, '@': 0.84,
  i: 0.30, l: 0.30, I: 0.34, j: 0.30, t: 0.42, f: 0.40, r: 0.42,
  '1': 0.55, '.': 0.28, ',': 0.28, ':': 0.28, ';': 0.28, "'": 0.28,
  '"': 0.40, '!': 0.34, '|': 0.28, ' ': 0.30,
};
/** Estimated pixel width of a string at `fontSize` (DejaVu Sans Bold). */
export function estimateTextPx(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of String(text ?? '')) {
    const w = CHAR_WIDTH_EM[ch];
    if (w !== undefined) em += w;
    else if (/[A-Z0-9]/.test(ch)) em += 0.62;
    else if (/[a-z]/.test(ch)) em += 0.55;
    else em += 0.50;
  }
  return em * fontSize;
}
/** Largest integer fontsize in [min, baseSize] so every bullet (marker+text)
 *  fits `maxWidth` with a 10px safety margin. Pure + unit-tested. */
export function fitBulletFontSize(
  bullets: Array<{ marker?: string; text: string }>,
  maxWidth: number,
  baseSize = 56,
  minFontSize = 26,
): number {
  const lines = bullets.map((b) => `${b.marker ?? ''}${b.text}`);
  let size = baseSize;
  while (size >= minFontSize) {
    const fits = lines.every((l) => estimateTextPx(l, size) <= Math.max(1, maxWidth - 10));
    if (fits) return size;
    size -= 2; // even steps — font metrics are discrete anyway
  }
  return minFontSize;
}
/** Resolve a bullet panel's geometry, clamped to the 1080x1920 frame with sane
 *  minimums, and a full-frame-safe default (bottom third, above bottom bar). */
export function resolveBulletPanel(panel: AssemblyBulletPanel | undefined): Required<AssemblyBulletPanel> {
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  const x = num(panel?.x, 60, 0, 960);
  const w = num(panel?.w, 960, 240, 1080 - x);
  const y = num(panel?.y, 1350, 100, 1750);
  const h = num(panel?.h, 240, 100, 1920 - y);
  return { x, y, w, h, bg: String(panel?.bg || 'black@0.85') };
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
    const groups: NonNullable<AssemblyOverlaySpec['perScene']> = [];
    for (let i = 0; i < Math.min(perScene.length, sceneCount); i++) {
      const g = perScene[i] as Record<string, unknown> | null | undefined;
      const group: { lines?: string[]; bullets?: AssemblyBullet[]; panel?: AssemblyBulletPanel } = {};
      // Backward-compat: plain `lines` (render #7) -> bullets without markers.
      const lines = Array.isArray(g?.lines)
        ? (g.lines as unknown[]).filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
        : [];
      const rawBullets = Array.isArray(g?.bullets) ? (g.bullets as unknown[]) : [];
      const bullets: AssemblyBullet[] = [];
      if (rawBullets.length > 0) {
        // New format: one bullet per entry, each with optional marker + bring-in
        // time. Malformed entries are dropped, never thrown.
        for (const b of rawBullets) {
          const bb = (b ?? {}) as Record<string, unknown>;
          const text = typeof bb.text === 'string' ? bb.text.trim() : '';
          if (!text) continue;
          const at = Number(bb.at);
          bullets.push({
            text,
            marker: typeof bb.marker === 'string' && bb.marker.trim() ? bb.marker : undefined,
            ...(Number.isFinite(at) && at > 0 ? { at } : {}),
          });
        }
      }
      if (lines.length > 0 || bullets.length > 0) {
        group.lines = lines.length > 0 ? lines : undefined;
        // Explicit `bullets` (render #8) drive the NEW panel/marker/autofit draw
        // path. Legacy `lines` keep the floating boxed look (render #7) — the
        // draw pass chooses by which field is present, never synthesizes one.
        if (bullets.length > 0) group.bullets = bullets;
        const panel = (g?.panel ?? {}) as Record<string, unknown>;
        if (panel && typeof panel === 'object' && (g as any)?.panel !== undefined) {
          group.panel = panel as AssemblyBulletPanel;
        }
        groups.push(group);
      }
    }
    if (groups.length > 0) spec.perScene = groups;
  }
  if (typeof r.bottomBar === 'string' && r.bottomBar.trim().length > 0) {
    spec.bottomBar = r.bottomBar.trim();
  }
  // END FLASH (ADJUST #3): text required; duration/bg/fg/fontSize optional.
  const flashRaw = (r.flash ?? {}) as Record<string, unknown> | null;
  if (flashRaw && typeof flashRaw === 'object') {
    const text = typeof flashRaw.text === 'string' ? flashRaw.text.trim() : '';
    const dur = Number(flashRaw.durationSec);
    if (text) {
      spec.flash = {
        text,
        ...(Number.isFinite(dur) && dur > 0.2 && dur <= 3 ? { durationSec: dur } : {}),
        bg: typeof flashRaw.bg === 'string' && flashRaw.bg.trim() ? flashRaw.bg : undefined,
        fg: typeof flashRaw.fg === 'string' && flashRaw.fg.trim() ? flashRaw.fg : undefined,
        ...(Number.isFinite(Number(flashRaw.fontSize)) && Number(flashRaw.fontSize) > 0 ? { fontSize: Number(flashRaw.fontSize) } : {}),
      };
    }
  }
  return spec.perScene || spec.bottomBar || spec.flash ? spec : null;
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
 *
 * Text content is written to temp files and referenced with `textfile=` +
 * `expansion=none` INSTEAD of inline `text='...'`. Inline text cannot safely
 * carry apostrophes / quotes: ffmpeg's filtergraph parser treats `'` as the
 * quoted-section delimiter, so `text='you don\'t pay'` breaks the graph mid-
 * expression (observed: `Missing ')' or too many args in 'between(t'` — the
 * next filter's `enable=` commas were consumed as filter separators). The
 * textfile route bypasses all quoting/escaping of user-visible text.
 *
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
    let textDir: string | null = null;
    let textCounter = 0;
    /** Write a user-visible text value to a temp file for `textfile=` (avoids
     *  all filtergraph quoting issues — apostrophes, quotes, colons, commas). */
    const writeTextFile = (line: string): string => {
      if (!textDir) textDir = fs.mkdtempSync(join(tmpdir(), 'empirelaunch-ovlytext-'));
      const f = join(textDir, `t${textCounter++}.txt`);
      fs.writeFileSync(f, line, 'utf8');
      return f;
    };
    try {
      const total = probeSeconds(inputFile) || (sceneStarts.length > 0 ? sceneStarts[sceneStarts.length - 1] + (sceneSeconds[sceneSeconds.length - 1] || 0) : 0);
      const vf: string[] = [];
      // Per-scene bullet groups: one drawtext per bullet, enabled only inside the
      // scene's dissolve-compensated [start, nextStart) window. Two shapes:
      //  - LEGACY `lines` (render #7): stacked floating lines, boxed, no markers —
      //    pixel-for-pixel backward compatible (the acceptance render's look).
      //  - RENDER #8 `bullets` (owner ADJUST #3): marker glyph + text drawn on a
      //    solid PANEL (bullets NOT words-over-photo), AUTOFIT fontsize (nothing
      //    cut off), and a staggered bring-in fade (each bullet's `at` seconds
      //    after its scene start, 450ms alpha ramp + 20px rise).
      (spec.perScene ?? []).forEach((group, gi) => {
        const start = sceneStarts[gi];
        const end = gi + 1 < sceneStarts.length ? sceneStarts[gi + 1] : total;
        if (gi >= sceneStarts.length || !Number.isFinite(start)) return;
        const enable = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
        const bullets = group.bullets;
        if (bullets && bullets.length > 0) {
          // RENDER #8 bullets on a panel.
          const panel = resolveBulletPanel(group.panel);
          const pad = 22;
          const maxWidth = Math.max(120, panel.w - pad * 2);
          const autoSize = fitBulletFontSize(bullets, maxWidth, 56);
          const lineH = Math.round(autoSize * 1.35);
          // Panel band (drawbox) behind the bullets, same scene window.
          vf.push(
            `drawbox=x=${panel.x}:y=${panel.y}:w=${panel.w}:h=${panel.h}:color=${panel.bg}:t=fill:${enable}`,
          );
          bullets.forEach((b, bi) => {
            const tf = writeTextFile(`${b.marker ?? ''}${b.text}`);
            const t0 = Math.max(start, start + (b.at ?? 0));
            const t1 = t0 + 0.45;
            const fade = `if(lt(t,${t0.toFixed(3)}),0,if(lt(t,${t1.toFixed(3)}),(t-${t0.toFixed(3)})/0.45,1))`;
            const yBase = Math.round(panel.y + pad + bi * lineH);
            vf.push(
              `drawtext=fontfile='${font}':textfile='${tf}':expansion=none:fontsize=${autoSize}:fontcolor=white:x=${panel.x + pad}:y='${yBase} + 20*(1-(${fade}))':alpha='${fade}':${enable}`,
            );
          });
          return;
        }
        // LEGACY floating lines (backward-compat path — identical output).
        if (!group.lines?.length) return;
        let y = 340;
        group.lines.forEach((line) => {
          const tf = writeTextFile(line);
          vf.push(
            `drawtext=fontfile='${font}':textfile='${tf}':expansion=none:fontsize=54:fontcolor=white:x=90:y=${y}:line_spacing=8:box=1:boxcolor=black@0.38:boxborderw=28:${enable}`,
          );
          y += 118;
        });
      });
      // Persistent bottom bar (translucent band + centered domain text), whole video.
      if (spec.bottomBar) {
        const bf = writeTextFile(spec.bottomBar);
        const enable = `enable='between(t,0,${total.toFixed(3)})'`;
        vf.push(
          `drawbox=x=0:y=1752:w=1080:h=168:color=black@0.72:t=fill:${enable}`,
          `drawtext=fontfile='${font}':textfile='${bf}':expansion=none:fontsize=60:fontcolor=white:x=(w-text_w)/2:y=1782:${enable}`,
        );
      }
      // END FLASH (owner ADJUST #3): full-frame flash + centered bold CTA in the
      // final `durationSec` (default 1.2s) — drawn LAST so it covers bars/bullets.
      if (spec.flash) {
        const dur = Math.min(3, Math.max(0.2, spec.flash.durationSec ?? 1.2));
        const t0 = Math.max(0, total - dur);
        const enable = `enable='between(t,${t0.toFixed(3)},${total.toFixed(3)})'`;
        const bg = spec.flash.bg || 'white';
        const fg = spec.flash.fg || '0x0a1f44';
        const flashFs = fitBulletFontSize([{ text: spec.flash.text }], 1000, spec.flash.fontSize ?? 96, 40);
        const ff = writeTextFile(spec.flash.text);
        const ramp = `if(lt(t,${t0.toFixed(3)}),0,if(lt(t,${(t0 + 0.15).toFixed(3)}),(t-${t0.toFixed(3)})/0.15,1))`;
        vf.push(
          `drawbox=x=0:y=0:w=1080:h=1920:color=${bg}:t=fill:${enable}`,
          `drawtext=fontfile='${font}':textfile='${ff}':expansion=none:fontsize=${flashFs}:fontcolor=${fg}:x=(w-text_w)/2:y=(h-text_h)/2:alpha='${ramp}':${enable}`,
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
    } finally {
      if (textDir) {
        try { fs.rmSync(textDir, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
      }
    }
  });
}
