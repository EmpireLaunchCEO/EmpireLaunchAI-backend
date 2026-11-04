/**
 * ASSEMBLY OVERLAY HELPERS (RENDER #7 PREP — owner ADJUST #2: bullets on screen +
 * EmpireLaunchAI.com at the bottom). Pure determinants, no ffmpeg, no DB:
 *   - resolveSceneVideoStarts: dissolve-compensated scene starts (same math as
 *     concatClips so bullet windows align with the delivered picture),
 *   - escapeDrawtext: user-visible text safe inside an ffmpeg drawtext value,
 *   - normalizeAssemblyOverlays: untrusted metadata → clean spec (or null).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSceneVideoStarts, escapeDrawtext, normalizeAssemblyOverlays, resolveOverlayFont } from '../assemblyOverlays.js';

test('resolveSceneVideoStarts: dissolve-compensated starts', () => {
  assert.deepEqual(resolveSceneVideoStarts([6, 5, 4], 0.8), [0, 5.2, 9.4]);
  assert.deepEqual(resolveSceneVideoStarts([6], 0.8), [0]);
  assert.deepEqual(resolveSceneVideoStarts([2, 2], 1.0), [0, 1]);
  // transition larger than a scene never yields negative starts
  const starts = resolveSceneVideoStarts([0.5, 4], 0.8);
  assert.ok(starts[0] === 0 && starts[1] >= 0);
});

test('escapeDrawtext: user text is safe in a drawtext value', () => {
  assert.equal(escapeDrawtext('Go to EmpireLaunchAI.com to get started today!!'), 'Go to EmpireLaunchAI.com to get started today!!');
  assert.equal(escapeDrawtext('a:b,c[d]%e\\f'), 'a\\:b\\,c\\[d\\]%%e\\\\f');
  assert.equal(escapeDrawtext("it's 100% real — don't"), "it\\'s 100%% real — don\\'t");
  assert.equal(escapeDrawtext(''), '');
});

test('normalizeAssemblyOverlays: clean spec / malformed dropped / null when empty', () => {
  // 5-scene launch metadata (owner's 8 lines grouped per F4 scene mapping)
  const spec = normalizeAssemblyOverlays(
    {
      perScene: [
        { lines: ['Introducing EmpireLaunch AI.', 'Your new go to platform.'] },
        { lines: ['You get 76 videos a month.', 'And you don\u2019t pay for credits.'] },
        { lines: [''] },
        { lines: [], },
        { lines: ['Go to EmpireLaunchAI.com to get started today!!'] },
      ],
      bottomBar: 'EmpireLaunchAI.com',
    },
    5,
  );
  assert.ok(spec, 'spec present');
  assert.equal(spec?.perScene?.length, 3, 'empty/malformed groups dropped');
  assert.equal(spec?.perScene?.[0]?.lines?.length, 2);
  assert.equal(spec?.bottomBar, 'EmpireLaunchAI.com');

  // absent / empty → null (today's pixel-exact output, zero re-encode)
  assert.equal(normalizeAssemblyOverlays(undefined, 5), null);
  assert.equal(normalizeAssemblyOverlays(null, 5), null);
  assert.equal(normalizeAssemblyOverlays({ perScene: [{ lines: [] }] }, 5), null);
  assert.equal(normalizeAssemblyOverlays({ bottomBar: '   ' }, 5), null);

  // over-long perScene trimmed to scene count
  const trimmed = normalizeAssemblyOverlays(
    { perScene: [{ lines: ['a'] }, { lines: ['b'] }], bottomBar: 'x' },
    1,
  );
  assert.equal(trimmed?.perScene?.length, 1, 'perScene trimmed to sceneCount');
});

test('resolveOverlayFont: a drawtext-usable font resolves on this runtime', () => {
  const f = resolveOverlayFont();
  assert.ok(f.length > 0);
});