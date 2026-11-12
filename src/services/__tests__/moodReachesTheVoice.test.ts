/**
 * MOOD REACHES THE VOICE (owner Nov 12 — "pick Mood=Calm and the read is still
 * the default lively one").
 *
 * The Faceless box sends `mood` (energetic|sad|calm|romantic|playful|dramatic|
 * inspiring) and `tone`. Before this fix the mood stopped at the planner prompt
 * (sceneVideoPipelineService.ts:3983): the gpt-audio call kept the default
 * 'auto' tone, so every video was read in the same lively default no matter what
 * the client picked. Now generateSceneAudio derives ONE delivery tone from the
 * mood when the client left tone on auto/unset, and that single tone feeds BOTH
 * the gpt-audio voice id and the read-aloud instruction.
 *
 * What is asserted, on the COMPOSED REQUEST BODY (not on source text):
 *   1. calm vs energetic produce DIFFERENT request bodies (voice + instruction).
 *   2. NEGATIVE CONTROL — neither mood nor tone set keeps the pre-existing
 *      default read exactly (default voice, lively instruction), and it differs
 *      from the calm body (so the assertion in (1) cannot pass trivially).
 *   3. An explicit tone still wins over the mood.
 *   4. All seven owner-locked moods map to a real, non-default delivery.
 *
 * No paid calls: globalThis.fetch is stubbed and never leaves the process.
 *   npx tsx --test src/services/__tests__/moodReachesTheVoice.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSceneAudio } from '../sceneVideoPipelineService.js';
import { resolveDeliveryTone, resolveVoice, FACELESS_MOODS } from '../voiceOptions.js';

type CapturedBody = any;

/** Capture every request body the TTS chain composes. The stub answers 401 so
 *  the pipeline never writes audio files and never reaches the network; the
 *  gpt-audio body (attempt 1) is the one under test. */
async function captureBody(
  tone: 'enthusiastic' | 'calm' | 'serious' | 'warm' | 'auto' | undefined,
  mood?: string,
): Promise<CapturedBody> {
  const bodies: CapturedBody[] = [];
  const realFetch = globalThis.fetch;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-not-used';
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(String(init?.body || '{}')));
    return { ok: false, status: 401, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } as any;
  }) as any;
  try {
    await generateSceneAudio('A calm evening by the water.', 'test-user', `mood_probe_${mood || 'none'}_${tone || 'none'}`, 'female', tone, mood ? { mood } : undefined);
  } catch {
    /* the stub always fails the chain — the composed body is what we keep */
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  }
  assert.ok(bodies.length > 0, 'the gpt-audio chain composed no request body');
  return bodies[0];
}

const instructionOf = (b: CapturedBody): string => String(b?.messages?.[0]?.content || '');
const voiceOf = (b: CapturedBody): string => String(b?.audio?.voice || '');

test('Mood=calm and Mood=energetic compose DIFFERENT gpt-audio request bodies', async () => {
  const calm = await captureBody('auto', 'calm');
  const energetic = await captureBody(undefined, 'energetic');

  assert.notEqual(JSON.stringify(calm), JSON.stringify(energetic), 'calm and energetic must not compose the same request');

  // Calm is actually READ calmly, with the calm voice.
  assert.match(instructionOf(calm), /a calm, steady, reassuring delivery/);
  assert.equal(voiceOf(calm), 'sage');
  assert.equal(voiceOf(calm), resolveVoice('female', 'calm'));

  // Energetic is read with enthusiasm, with the energetic voice.
  assert.match(instructionOf(energetic), /bright, energetic enthusiasm/);
  assert.equal(voiceOf(energetic), 'nova');
  assert.equal(voiceOf(energetic), resolveVoice('female', 'enthusiastic'));

  assert.notEqual(instructionOf(calm), instructionOf(energetic));
  assert.notEqual(voiceOf(calm), voiceOf(energetic));
});

test('NEGATIVE CONTROL: neither mood nor tone keeps the default lively read', async () => {
  const none = await captureBody(undefined, undefined);
  const autoTone = await captureBody('auto', undefined);

  // Pre-existing behaviour, unchanged: default voice + the lively default read.
  for (const b of [none, autoTone]) {
    assert.equal(voiceOf(b), resolveVoice('female', 'auto'));
    assert.equal(voiceOf(b), 'nova');
    assert.match(instructionOf(b), /a natural, lively, engaging delivery/);
  }
  // ...and it is genuinely DIFFERENT from a mood-driven read, so the calm/energetic
  // difference above cannot be an artefact of the harness.
  const calm = await captureBody('auto', 'calm');
  assert.notEqual(JSON.stringify(none), JSON.stringify(calm));
  assert.notEqual(instructionOf(none), instructionOf(calm));
});

test('an explicit tone still wins over the mood', async () => {
  const serious = await captureBody('serious', 'energetic');
  assert.match(instructionOf(serious), /a serious, confident, professional delivery/);
  assert.doesNotMatch(instructionOf(serious), /bright, energetic enthusiasm/);
  assert.equal(voiceOf(serious), resolveVoice('female', 'serious'));
});

test('every owner-locked mood maps to a real, non-default delivery', async () => {
  const defaultVoice = resolveVoice('female', 'auto');
  const defaultInstruction = instructionOf(await captureBody(undefined, undefined));
  for (const mood of FACELESS_MOODS) {
    const tone = resolveDeliveryTone(undefined, mood);
    assert.notEqual(tone, 'auto', `mood ${mood} must not fall back to the default delivery`);
    const body = await captureBody(undefined, mood);
    assert.notEqual(JSON.stringify(body), JSON.stringify(await captureBody(undefined, undefined)), `mood ${mood} composed the default body`);
    assert.ok(
      instructionOf(body) !== defaultInstruction || voiceOf(body) !== defaultVoice,
      `mood ${mood} reached neither the voice nor the read instruction`,
    );
  }
  // calm and energetic are genuinely on different sides of the mapping.
  assert.equal(resolveDeliveryTone(undefined, 'calm'), 'calm');
  assert.equal(resolveDeliveryTone(undefined, 'energetic'), 'enthusiastic');
  assert.equal(resolveDeliveryTone(undefined, undefined), 'auto');
});
