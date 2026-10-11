/**
 * NEURAL TWIN REBUILD — zero-API discriminating suite (owner Oct 11 "fix twin",
 * task 7e3f8e3a). The twin engine was a SEPARATE silent-caption engine (audit
 * d390c9b9: no createProject/video_projects, zero F4/TTS, <text>-baked SVG frames,
 * silent compose). This suite proves the REBUILT state without any paid render:
 *  - F4: every finished-essence selling point is SPOKEN in the twin plan (7/7);
 *  - F1: twin frames are NO-TEXT SVGs (no <text>, no emotion label, no script);
 *  - avatar: every segment is avatar-dialogue, SAME avatar look enforced;
 *  - visuals: benefit text is BANNED from every visualPrompt;
 *  - duration: dissolve-compensated + INTEGER-safe deliveredVideoDurationSeconds;
 *  - voice:'none' parity (silent-by-design stays possible);
 *  - REAL ffmpeg graph: per-segment renderClip + concatClips yields an OUTPUT WITH
 *    AN AUDIO STREAM at the planned delivered length (the old compose was silent).
 * Run this file ALONE (it executes the real ffmpeg graph — sandbox 3.9GB/no swap).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { buildTwinPlan, buildTwinFrameSvg, buildTwinVisualPrompt, splitTwinScript, toneFromTwinRequest } from '../cinemaEngineService.js';
import { renderClip, concatClips, verifySellingPointsSpoken, deliveredVideoDuration, deliveredVideoDurationSeconds } from '../sceneVideoPipelineService.js';

// A FINISHED twin pitch (client-directed, 7+ relayed selling points — the twin
// engine's transformTwinScriptToPitch output shape).
const TWIN_PITCH = [
  'Introducing EmpireLaunch AI — the all-in-one content creation platform.',
  'It creates professional videos for you in minutes.',
  'It writes every caption and hashtag for you automatically.',
  'It posts to TikTok, Instagram, and YouTube on autopilot.',
  'It saves you hours every single week.',
  'Stop paying for five separate apps, because EmpireLaunch AI does it all in one place.',
  'Go to empirelaunchai.com and sign up today.',
].join(' ');

const DNA = {
  faceShape: 'oval', skinTone: 'medium', eyeColor: 'brown', hairStyle: 'straight',
  hairColor: 'brown', jawline: 'defined', lipShape: 'medium', noseShape: 'straight',
  eyebrowShape: 'arched', distinctiveFeatures: [],
};

test('twin F4: every finished-essence selling point is SPOKEN in the rebuilt plan (incl. backstop-injected)', () => {
  const r = buildTwinPlan(TWIN_PITCH, 30, 'female');
  assert.ok(r.sellingPoints.length >= 4, `pitch should yield >=4 selling points (got ${r.sellingPoints.length})`);
  const missing = verifySellingPointsSpoken(r.plan, r.sellingPoints).missing;
  assert.deepEqual(missing, [], 'F4: every relayed selling point must be spoken (missing=' + missing.join(' | ') + ')');
  assert.deepEqual(r.f4StillMissing, [], 'no still-missing selling points after buildTwinPlan');
  // the non-verbatim canonical sentence is appended by the F4 backstop (miss→inject):
  const joinedNarr = r.plan.map((s) => String(s.narration || '').toLowerCase()).join(' ');
  assert.ok(joinedNarr.includes('your go-to content creation platform'), 'F4 backstop must inject the non-verbatim selling point');
  // every narration non-empty (silent segments would break the spoken guarantee)
  for (const s of r.plan) assert.ok(String(s.narration || '').trim().length > 0, `segment ${s.sceneNumber} narration empty`);
});

test('twin avatar: every segment is avatar-dialogue and the SAME avatar look is enforced', () => {
  const r = buildTwinPlan(TWIN_PITCH, 30, 'female');
  for (const s of r.plan) {
    assert.equal(s.narrationRole, 'avatar-dialogue', `segment ${s.sceneNumber} must be a talking-avatar line`);
    assert.ok(String(s.visualPrompt || '').toLowerCase().includes('talking-head'), `segment ${s.sceneNumber} visual must describe the talking head`);
  }
  assert.equal(r.narrationRoles.length, r.plan.length);
  assert.ok(r.narrationRoles.every((x) => x === 'avatar-dialogue'));
});

test('twin F4 visual ban: benefit text never appears in any visualPrompt (F1/F4)', () => {
  const r = buildTwinPlan(TWIN_PITCH, 30, 'female');
  const banned = r.sellingPoints.filter((c) => !/^EmpireLaunch AI\.$/i.test(c));
  const joined = r.plan.map((s) => String(s.visualPrompt || '').toLowerCase()).join(' ');
  for (const c of banned) {
    const phrase = String(c).toLowerCase().replace(/\s+/g, ' ').trim();
    if (phrase) assert.ok(!joined.includes(phrase), `visualPrompt must not contain benefit text: "${c}"`);
  }
});

test('twin F1: frames are NO-TEXT SVGs (no <text>, no emotion label, no script line)', () => {
  const svg = buildTwinFrameSvg(DNA, 'confident', 0.5);
  assert.ok(!/<text/i.test(svg), 'SVG must contain no <text> element (old baked captions are GONE)');
  assert.ok(!/confident|CONFIDENT/i.test(svg), 'emotion must NEVER be painted as a label into the frame');
  assert.ok(/<ellipse/.test(svg) && svg.includes('1080') && svg.includes('1920'), 'SVG keeps the talking-head geometry at 9:16');
});

test('twin duration: dissolve-compensated sum, INTEGER-safe DB value, delivered in-band (15s and 30s)', () => {
  for (const target of [15, 30]) {
    const r = buildTwinPlan(TWIN_PITCH, target, 'female');
    const rawSum = r.plan.reduce((a, s) => a + s.duration, 0);
    const overlaps = Math.max(0, r.plan.length - 1) * 0.8;
    assert.ok(Math.abs(rawSum - overlaps - r.delivered) < 0.01, 'delivered = sum − overlaps');
    assert.ok(Math.abs(r.delivered - target) <= 0.5, `delivered ${r.delivered}s inside the ${target}s ± 0.5 band`);
    assert.ok(Number.isInteger(r.deliveredSeconds), 'total_duration column value must be an INTEGER (PR #114)');
    assert.equal(r.deliveredSeconds, target, `INTEGER value must land on the target (${target})`);
    for (const s of r.plan) assert.ok(s.duration >= 1, `segment ${s.sceneNumber} duration >= 1s (got ${s.duration})`);
  }
});

test('twin voice:none parity: silent-by-design keeps integers, roles, and spoken F4 audit', () => {
  const r = buildTwinPlan(TWIN_PITCH, 30, 'none');
  assert.deepEqual(r.f4Injected, [], 'voice:none must NOT inject narration (silent keeps visual-only channel)');
  assert.ok(Number.isInteger(r.deliveredSeconds) && r.deliveredSeconds === 30, 'voice:none still int-safe');
  assert.ok(r.narrationRoles.every((x) => x === 'avatar-dialogue'), 'roles unchanged by voice:none');
  // F4 still AUDITS (reports missing) without injecting:
  const missing = verifySellingPointsSpoken(r.plan, r.sellingPoints).missing;
  assert.ok(Array.isArray(missing), 'voice:none F4 audit still runs');
});

test('twin plan helpers: splitTwinScript covers the full script (no dropped words); tone maps voiceStyle/mood', () => {
  const segs = splitTwinScript(TWIN_PITCH, 5);
  assert.equal(segs.length, 5);
  const joined = segs.join(' ').replace(/\s+/g, ' ').trim();
  const orig = TWIN_PITCH.replace(/\s+/g, ' ').trim();
  const origWords = orig.split(' ');
  for (const w of origWords) {
    assert.ok(joined.includes(w), `script word "${w}" must survive segmentation (content-loss guard)`);
  }
  assert.equal(toneFromTwinRequest('energetic'), 'enthusiastic');
  assert.equal(toneFromTwinRequest('calm'), 'calm');
  assert.equal(toneFromTwinRequest('natural'), 'auto');
  assert.equal(toneFromTwinRequest(undefined, 'serious'), 'serious');
  assert.equal(toneFromTwinRequest(undefined, 'warm'), 'warm');
});

test('REAL GRAPH: shared twin compose (renderClip + concatClips) outputs an AUDIO stream at the planned delivered length', { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twin_graph_'));
  try {
    // 2 tiny still frames (talking-head stand-ins; the graph is what's under test)
    const p0 = path.join(dir, 'f0.png');
    const p1 = path.join(dir, 'f1.png');
    const frameSpecs: Array<[string, { r: number; g: number; b: number }]> = [
      [p0, { r: 26, g: 26, b: 46 }],
      [p1, { r: 40, g: 30, b: 60 }],
    ];
    for (const [p, bg] of frameSpecs) {
      await sharp({ create: { width: 270, height: 480, channels: 3, background: bg } }).png().toFile(p);
    }
    // synthetic 6s tone standing in for GPT-Audio TTS (zero paid calls)
    const tone = path.join(dir, 'tone.mp3');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-y', tone]);
    // segments planned at [4s, 5s] → delivered = 4 + 5 − 0.8 xfade = 8.2s
    const seg0 = path.join(dir, 'seg0.mp4');
    const seg1 = path.join(dir, 'seg1.mp4');
    await renderClip(p0, seg0, 4, tone);
    await renderClip(p1, seg1, 5, tone);
    const out = path.join(dir, 'out.mp4');
    await concatClips([seg0, seg1], out);
    // AUDIO STREAM PRESENT (GAP4: the old compose was silent)
    const audioStreams = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out], { maxBuffer: 1024 * 1024 }).toString().trim();
    assert.ok(audioStreams.length > 0, 'assembled twin must carry an AUDIO stream (old silent compose is gone)');
    // DELIVERED LENGTH ≈ planned (8.2 ± 0.5 — PR #112 math)
    const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out], { maxBuffer: 1024 * 1024 }).toString().trim());
    assert.ok(Number.isFinite(dur), 'probeable duration');
    assert.ok(Math.abs(dur - 8.2) <= 0.5, `delivered ${dur}s within [7.7, 8.7] band (planned 8.2)`);
    assert.equal(deliveredVideoDurationSeconds([{ duration: 4 }, { duration: 5 }]), 8, 'int-safe helper agrees (8)');
    assert.ok(Math.abs(deliveredVideoDuration([{ duration: 4 }, { duration: 5 }]) - 8.2) < 0.01, 'precise helper agrees (8.2)');
    // silent-by-design parity: single clip with NO audio → no audio stream
    const silent = path.join(dir, 'silent.mp4');
    await renderClip(p0, silent, 2);
    const silentAudio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', silent], { maxBuffer: 1024 * 1024 }).toString().trim();
    assert.equal(silentAudio.length, 0, 'renderClip without audio must stay silent (voice:none parity)');
    assert.ok(buildTwinVisualPrompt('confident').toLowerCase().includes('no text'), 'visual prompt documents the no-text contract');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});