/**
 * THE THREE DEFECTS THAT BROKE THE OWNER'S 18 NOV FACELESS VIDEO (owner Nov 18,
 * project 44468e9a: `failureCode: COMPONENTS_NOT_PLACED`, requested 15s, planned 20s,
 * scenes 8/6/8).
 *
 * WHAT THIS FILE PINS — one test per defect, each on a real artefact and each with a
 * negative control so the fixture can fail:
 *
 *   1. THE REFUSAL. Her own conversation-derived inventory (13 fragments including
 *      "red", two near-duplicate platform sentences and the synthesised
 *      "EmpireLaunchAi — the …" splice) no longer blocks the render, while a
 *      component she genuinely stated and the plan genuinely drops still blocks.
 *   2. THE NARRATION. The two-pass F4 injection over a dictated opening never
 *      stacks two sentences on one scene, and her dictated line is PREPENDED (the
 *      planner's scene-1 copy survives). Plus: a removed component splice never
 *      leaves a verb with no destination ("…and the process is Go to").
 *   3. 15 SECONDS MEANS 15. A 15-second Faceless request delivers within ±1s of 15,
 *      buying no more Veo than the plan can show — while a 30-second request still
 *      buys the owner-approved 16s in two 8s calls.
 *   5. THE GATE RUNS AFTER THE SANITISER: a placement the one repair pass won and the
 *      sanitiser then cleaned is not counted missing.
 *
 * ZERO PAID CALLS: everything here is pure planning/QC code plus text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  buildComponentInventory,
  buildStyleGuidance,
  isColourOnlyComponent,
  resolveGateMissingComponents,
  componentsNotPlacedNotice,
  injectSellingPointsIntoNarration,
  verifySellingPointsSpoken,
  planFacelessVeoWindows,
  planFacelessVeoSpans,
  applyVeoSceneMotion,
  fitMotionWindowsToSlots,
  parseScenePlan,
  normalizePlanTimeBudget,
  deliveredVideoDuration,
  type SceneScript,
} from '../sceneVideoPipelineService.js';
import {
  enforceDictatedOpening,
  sanitizeComponentSpliceFromNarration,
  sanitizePlanComponentSplices,
} from '../plannerFidelity.js';

const SERVICE_SRC = fs.readFileSync(
  path.join(process.cwd(), 'src', 'services', 'sceneVideoPipelineService.ts'),
  'utf8',
);

const containsAny = (haystack: string[], needle: string) =>
  haystack.some((h) => h.toLowerCase().includes(needle.toLowerCase()));

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE REFUSAL — her own words must never block a video for obeying the brief
// ═══════════════════════════════════════════════════════════════════════════════

/** Her chat turns, reconstructed from the failed project's inventory: the two
 *  near-duplicate platform sentences, the colour, and the CTA. */
const OWNER_CONVERSATION = [
  { role: 'user', content: 'I want a 15 second video for EmpireLaunchAi.' },
  { role: 'assistant', content: 'Love it — a 15s launch video. What should it show?' },
  {
    role: 'user',
    content:
      'EmpireLaunchAi is the new content creation platform. This platform will be all you need. ' +
      'It is a must have for content creation. Use red. Go to Empirelaunchai.com.',
  },
  // The synthesised splice the failed project carried, next to the shorter sentence
  // it was built from ("…the This platform is a must have cor content creation").
  {
    role: 'user',
    content:
      'EmpireLaunchAi — the This platform is a must have cor content creation. ' +
      'This platform is a must have cor content creation.',
  },
  { role: 'assistant', content: 'Perfect — EmpireLaunchAi, a must have, red, and the site. Got it.' },
];
const OWNER_IDEA = 'A 15 second launch video for EmpireLaunchAi.';

const ownerInventory = () =>
  buildComponentInventory({
    components: [],
    cleanBrief: OWNER_IDEA,
    conversation: OWNER_CONVERSATION as any,
  });

test('THE REFUSAL: her 13 conversation fragments produce NO blocking component', () => {
  const inventory = ownerInventory();
  assert.ok(inventory.length > 0, 'fixture: her words really are inventoried');

  // (a) A COLOUR IS NOT A SPOKEN COMPONENT — it lives in style guidance now.
  assert.equal(
    inventory.some((c) => isColourOnlyComponent(c)),
    false,
    `no colour may be a spoken component (got: ${inventory.join(' | ')})`,
  );
  const style = buildStyleGuidance({ components: [], cleanBrief: OWNER_IDEA, conversation: OWNER_CONVERSATION as any });
  assert.ok(style.includes('red'), `"red" reaches the planner as style guidance (got: ${style.join(' | ')})`);

  // (b) CONTAINMENT DEDUPE — no item is inside another, and the synthesised
  //     "EmpireLaunchAi — the This platform is a must have…" splice is gone.
  for (const a of inventory) {
    for (const b of inventory) {
      if (a === b) continue;
      assert.equal(
        b.toLowerCase().includes(a.toLowerCase()),
        false,
        `"${a}" must not be a fragment of "${b}" — one statement, one component`,
      );
    }
  }
  assert.equal(
    inventory.some((c) => /^empirelaunch\s*ai\s*[—-]\s*the/i.test(c)),
    false,
    `the synthesised essence splice must never be a component (got: ${inventory.join(' | ')})`,
  );

  // (c) THE GATE. A plan that contains NONE of these sentences (the real shape: the
  //     planner writes its own scenes) must not be refused.
  const gateMissing = resolveGateMissingComponents({
    missingComponents: inventory,
    cleanIdea: OWNER_IDEA,
    conversation: OWNER_CONVERSATION as any,
    explicitComponents: [],
  });
  assert.deepEqual(gateMissing, [], `the gate must not fire on her own framing (blocked: ${gateMissing.join(' | ')})`);
  assert.equal(componentsNotPlacedNotice(gateMissing), null, 'no refusal is produced');

  // NEGATIVE CONTROL — a component she stated that the plan really drops still blocks.
  const blocked = resolveGateMissingComponents({
    missingComponents: [...inventory, 'a spinning gold trophy'],
    cleanIdea: OWNER_IDEA,
    conversation: OWNER_CONVERSATION as any,
    explicitComponents: ['a spinning gold trophy'],
  });
  assert.deepEqual(blocked, ['a spinning gold trophy'], 'a genuinely absent stated component STILL blocks');
  assert.notEqual(componentsNotPlacedNotice(blocked), null, 'and it produces the plain-language refusal');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE NARRATION — one sentence per scene, her line prepended
// ═══════════════════════════════════════════════════════════════════════════════

const THREE_SCENES: SceneScript[] = [
  { sceneNumber: 1, duration: 6, visualType: 'still', visualPrompt: 'A bakery counter at dawn', narration: 'Fresh bread, baked before the sun comes up.' },
  { sceneNumber: 2, duration: 6, visualType: 'still', visualPrompt: 'Hands pulling a golden loaf from the oven', narration: 'Every loaf is made by hand, the same way every morning.' },
  { sceneNumber: 3, duration: 6, visualType: 'still', visualPrompt: 'The storefront at golden hour', narration: 'Come by this weekend and try it yourself.' },
];

/** Two hook-ish sentences — the shape that produced "Introducing EmpireLaunchAi.
 *  EmpireLaunchAi." on ONE scene. */
const HOOK_POINTS = ['Introducing EmpireLaunchAi', 'Your go-to content creation platform'];
const DICTATED = 'Hey, I am so glad you are here';

test('THE NARRATION: her line plays VERBATIM in scene 1 and the two F4 passes never repeat a sentence', () => {
  // The real sequence: full injection → dictated opening → skip-scene-zero re-injection.
  const pass1 = injectSellingPointsIntoNarration(THREE_SCENES, HOOK_POINTS);
  assert.ok(pass1.injected.length > 0, 'fixture: the points really were missing');

  const fidelity = enforceDictatedOpening(pass1.script, DICTATED);
  assert.equal(fidelity.patched, true, 'fixture: scene 1 did not already start with her line');
  const pass2 = injectSellingPointsIntoNarration(fidelity.script, HOOK_POINTS, { skipSceneZero: true });

  // (a) HER LINE IS SCENE 1, EXACTLY — the replace contract this function exists for.
  assert.equal(
    pass2.script[0].narration,
    `${DICTATED}.`,
    `scene 1 is her dictated line verbatim (got: "${pass2.script[0].narration}")`,
  );

  // (b) THE DUPLICATE IS STILL GONE. The defect said "Introducing EmpireLaunchAi.
  //     EmpireLaunchAi." on one scene; every point is now spoken EXACTLY ONCE in the
  //     whole script — nothing repeated, nothing lost to a crushed scene.
  const whole = pass2.script.map((s) => String(s.narration)).join(' ').toLowerCase();
  for (const point of HOOK_POINTS) {
    const hits = whole.split(point.toLowerCase()).length - 1;
    assert.equal(hits, 1, `"${point}" is spoken exactly once (got ${hits}): ${whole}`);
  }
  for (const scene of pass2.script) {
    const held = HOOK_POINTS.filter((p) => String(scene.narration).toLowerCase().includes(p.toLowerCase()));
    assert.ok(
      held.length <= 1,
      `scene ${scene.sceneNumber} must not hold two injected sentences (got "${scene.narration}")`,
    );
  }

  // (c) THE OVERWRITE'S CONSEQUENCE, HANDLED: only the line the replace erased comes
  //     back, and it lands on a scene that holds no point — never on scene 1, never on
  //     top of the other point.
  assert.deepEqual(pass2.injected, ['Introducing EmpireLaunchAi'], 'only the erased line is re-added');
  const reAdded = pass2.script.findIndex((s) => String(s.narration).includes('Introducing EmpireLaunchAi'));
  const alreadyHad = pass2.script.findIndex((s) =>
    String(s.narration).includes('Your go-to content creation platform'),
  );
  assert.notEqual(reAdded, alreadyHad, 'the re-added hook does not land on the scene already holding a point');
  assert.notEqual(reAdded, 0, 'and never on scene 1 — her line is untouchable');
  assert.deepEqual(verifySellingPointsSpoken(pass2.script, HOOK_POINTS).missing, [], 'every point is still spoken');

  // NEGATIVE CONTROL — a genuinely missing sentence still gets injected, exactly once.
  const missing = injectSellingPointsIntoNarration(THREE_SCENES, ['76 video creations a month']);
  assert.deepEqual(missing.injected, ['76 video creations a month'], 'a real missing sentence is still injected');
  assert.equal(
    missing.script.filter((s) => String(s.narration).toLowerCase().includes('76 video creations a month')).length,
    1,
    'in exactly one scene',
  );
});

test('THE NARRATION: a removed component splice never leaves a verb with no destination', () => {
  const phrases = ['Go to Empirelaunchai.com'];

  // The defect: "…and the process is Go to Empirelaunchai.com." → "…and the process is Go to".
  const res = sanitizeComponentSpliceFromNarration("It's simple and the process is Go to Empirelaunchai.com.", { phrases });
  assert.deepEqual(res.removed, phrases, 'fixture: the splice really was removed');
  assert.equal(res.text, "It's simple.", `the line ends on a complete clause (got: "${res.text}")`);
  assert.equal(
    /(?:\b(?:to|of|for|with|in|on|the|a|an|is|are|and|or|but|that|which)\s*[.!?]?)$/i.test(res.text.trim()),
    false,
    `no dangling function word at the end (got: "${res.text}")`,
  );

  // A second shape: the broken clause is the whole line → the sentence goes, not a stump.
  const bare = sanitizeComponentSpliceFromNarration('The process is Go to Empirelaunchai.com.', { phrases });
  assert.equal(bare.text.trim(), '', `nothing is spoken rather than a stump (got: "${bare.text}")`);

  // NEGATIVE CONTROL — clean narration is a byte-exact no-op.
  const clean = 'Fresh bread, baked before the sun comes up.';
  assert.equal(sanitizeComponentSpliceFromNarration(clean, { phrases }).text, clean, 'clean narration is untouched');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. 15 SECONDS MEANS 15
// ═══════════════════════════════════════════════════════════════════════════════

const SCENES_15 = {
  scenes: [
    { sceneNumber: 1, duration: 8, visualType: 'still', visualPrompt: 'A bakery counter at dawn, fresh loaves', narration: 'Fresh bread, baked before the sun comes up.' },
    { sceneNumber: 2, duration: 6, visualType: 'still', visualPrompt: 'Hands pulling a golden loaf from the oven', narration: 'Every loaf is made by hand.' },
    { sceneNumber: 3, duration: 8, visualType: 'still', visualPrompt: 'The storefront at golden hour', narration: 'Come by this weekend.' },
  ],
};
const SCENES_30 = {
  scenes: [1, 2, 3, 4, 5].map((n) => ({
    sceneNumber: n,
    duration: 6,
    visualType: 'still',
    visualPrompt: `Bakery scene ${n}`,
    narration: `Bakery line ${n}.`,
  })),
};

/** MIRROR of createProject's Faceless motion sequence, in its order. */
function facelessPlan(raw: any, targetSeconds: number) {
  const parsed = parseScenePlan(raw, `A ${targetSeconds} second promo for my bakery.`, targetSeconds, 'faceless');
  const normalized = normalizePlanTimeBudget(parsed, targetSeconds, { dissolveCompensate: true });
  const spans = planFacelessVeoSpans(normalized);
  const planned = applyVeoSceneMotion(normalized, spans);
  const fit = fitMotionWindowsToSlots(planned, spans);
  const motionSeconds = spans.reduce((a, sp) => a + sp.windows.reduce((b, w) => b + w.motionSeconds, 0), 0);
  const windows = spans.reduce((a, sp) => a + sp.windows.length, 0);
  return { normalized, spans, planned, fit, motionSeconds, windows };
}

test('15 SECONDS MEANS 15: the delivered video lands on 15s, and Veo buys only what it can show', () => {
  const { normalized, planned, fit, motionSeconds, windows } = facelessPlan(SCENES_15, 15);

  // Fixture: the real shape — three dissolve-compensated slots summing to 17.
  assert.equal(normalized.length, 3, 'fixture: three scenes');
  const sceneSum = normalized.reduce((a, s) => a + Number(s.duration), 0);
  assert.equal(sceneSum, 17, `the scene sum is the dissolve-compensated 17 (got ${sceneSum})`);

  // THE DEFECT: 16s of motion grew both slots to 8 and the file shipped at 20.4s.
  assert.ok(motionSeconds <= 15, `motion never exceeds the request (bought ${motionSeconds}s for a 15s video)`);
  assert.ok(
    Math.abs(fit.report.deliveredSeconds - 15) <= 1,
    `delivered ${fit.report.deliveredSeconds}s must land within 1s of the 15s she asked for`,
  );
  assert.equal(fit.report.unabsorbedSeconds, 0, 'nothing is left over to make the video long');
  assert.ok(windows >= 1 && windows <= 2, `at most the two approved calls (got ${windows})`);

  // NEGATIVE CONTROL — a 30-second request still buys the owner-approved 16s in two 8s calls.
  const thirty = facelessPlan(SCENES_30, 30);
  assert.equal(thirty.windows, 2, 'a 30s video still gets exactly two windows');
  assert.equal(thirty.motionSeconds, 16, 'and still 16s of paid motion');
  assert.deepEqual(thirty.spans[0].windows.map((w) => w.motionSeconds), [8, 8], 'two 8-second calls');

  // NEGATIVE CONTROL — a video too short to host two takes buys ONE window.
  const tiny = facelessPlan(
    { scenes: [{ sceneNumber: 1, duration: 7, visualType: 'still', visualPrompt: 'A single bakery shot', narration: 'Fresh bread.' }] },
    7,
  );
  assert.equal(tiny.windows, 1, `a 7s single-scene video buys one window (got ${tiny.windows})`);
  assert.ok(tiny.motionSeconds <= 7, `and no more motion than the video has (got ${tiny.motionSeconds}s)`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. THE GATE RUNS AFTER THE SANITISER
// ═══════════════════════════════════════════════════════════════════════════════

test('THE GATE: a repaired placement the sanitiser then cleaned is not counted missing', () => {
  const cleanIdea = 'A launch video for my bakery.';
  const plan: SceneScript[] = [
    { sceneNumber: 1, duration: 6, visualType: 'still', visualPrompt: 'Bakery counter', narration: 'Fresh bread, baked before the sun comes up, and the process is Go to Empirelaunchai.com.' },
  ];
  const phrase = 'Go to Empirelaunchai.com';
  const sanitized = sanitizePlanComponentSplices(plan, { phrases: [phrase] });
  assert.deepEqual(sanitized.changedScenes, [1], 'fixture: the sanitiser really cleaned the repaired placement');

  // The repair won the placement; the sanitiser cleaned its copy. Not missing.
  assert.deepEqual(
    resolveGateMissingComponents({
      missingComponents: [phrase],
      cleanIdea,
      conversation: [],
      repairedPlaced: [phrase],
    }),
    [],
    'a placement the repair pass won is placed, whatever the sanitiser did to the copy',
  );

  // NEGATIVE CONTROL — without the repair, the same absence still blocks.
  assert.deepEqual(
    resolveGateMissingComponents({ missingComponents: [phrase], cleanIdea, conversation: [], repairedPlaced: [] }),
    [phrase],
    'the gate still blocks an item nothing placed',
  );

  // ...and the decision really is taken on the plan AFTER the sanitiser. The gate
  // moved into the component ladder (blockingGateItems -> resolveGateMissingComponents)
  // and its verdict reaches the refusal through `gateMissing = stillBlocking`, so BOTH
  // the resolver call and the refusal's gate must sit after the splice pass. (This is
  // the assertion that went stale: it looked for a `gateMissing = resolveGate...`
  // line that the ladder replaced, so it failed on the source, not on the behaviour.)
  const spliceAt = SERVICE_SRC.indexOf('const splicePass = narrationAuthoritative');
  const resolverAt = SERVICE_SRC.indexOf('resolveGateMissingComponents({');
  const gateAt = SERVICE_SRC.indexOf('const gateMissing = stillBlocking;');
  assert.ok(spliceAt > 0, 'the splice pass is still in createProject');
  assert.ok(resolverAt > spliceAt, 'the gate resolver is called after the splice sanitiser');
  assert.ok(gateAt > spliceAt, 'and the refusal is decided on the plan the sanitiser produced');
});
