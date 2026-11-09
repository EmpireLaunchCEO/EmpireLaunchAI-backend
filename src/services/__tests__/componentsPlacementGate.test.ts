/**
 * DEFECT 2 — `componentsVerified:false` shipped anyway.
 *
 * The project row recorded `componentsVerified: qc.missingComponents.length===0` and
 * `componentsMissing:[...]`, the comment above it said "Never blocks", and NOTHING in
 * the app read either field. So a client's brief could be planned into a video that
 * silently dropped what she asked for, and the only trace was a field nobody reads.
 *
 * This defect is NOT fixed by adding a gate. The pieces have to LAND first, and the
 * gate stays as the backstop for what still cannot be placed:
 *
 *   2a  the planner gets the numbered checklist UP FRONT and states, per item, which
 *       scene covers it;
 *   2b  "missing" is decided by that ASSIGNMENT, not by a substring of free text (the
 *       substring test is what turned "premium feel" into a missing "premium" and then
 *       painted the phrase onto scene 1);
 *   2c  ONE text-only repair pass asks the planner to place what is genuinely
 *       unassigned \u2014 text in, text out, no image, no audio, no Veo;
 *   2d  the gate, before any paid media call, on what is STILL missing.
 *
 * Pure + offline: no model call, no media, no database, no spend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildComponentInventory,
  buildPlannerComponentsSection,
  verifyComponentsInScript,
  injectMissingComponents,
  stripBenefitTextFromVisualPrompts,
  componentAssignmentsFromPlan,
  buildComponentRepairRequest,
  applyComponentRepair,
  componentsNotPlacedNotice,
  resolveProjectCreationOutcome,
  parseScenePlan,
  COMPONENTS_NOT_PLACED_CODE,
  type SceneScript,
} from '../sceneVideoPipelineService.js';

const scene = (n: number, visualPrompt: string, narration = ''): SceneScript => ({
  sceneNumber: n, duration: 6, visualType: 'still', visualPrompt, narration,
});

/** The owner's own kind of item: concrete, named in chat, nothing the template arc says. */
const ITEM = 'hand-poured soy wax candle in a matte amber jar';

const inventoryWith = (item: string): string[] =>
  buildComponentInventory({ components: [], cleanBrief: '', conversation: [{ role: 'user', content: item }] });

// ─── 2a. the checklist is in the planner prompt, up front ────────────────────
test('2a: the planner is handed the numbered checklist AND must state where each item lands', () => {
  const inventory = inventoryWith(ITEM);
  assert.ok(inventory.includes(ITEM), `the item must be in the inventory: ${JSON.stringify(inventory)}`);
  const section = buildPlannerComponentsSection(inventory, 'female');
  assert.match(section, /COMPONENTS INVENTORY/, 'the checklist itself');
  assert.match(section, /(^|\n)\d+\. "/, 'numbered, so the planner can answer item by item');
  assert.match(section, /"hand-poured soy wax candle in a matte amber jar"/, 'the item is listed verbatim');
  assert.match(section, /componentAssignments/, 'the planner must return its per-item assignment');
  assert.match(section, /"component"[\s\S]*"scene"/, 'the assignment shape is spelled out');
  assert.match(section, /ADDITIONAL top-level key/, 'and it is additional, so the plan shape is unchanged');
});

// ─── 2b. the verdict is the ASSIGNMENT, not a substring ─────────────────────
test('2b: an assigned item is PRESENT even when the plan words it differently', () => {
  const script = [
    scene(1, 'Establishing shot of the shop', 'Say hello to the calm of a slow morning.'),
    scene(2, 'Wax pouring in the studio', 'Everything about this one feels considered.'),
  ];
  const item = 'the premium feel';
  // The substring test alone says "missing" (the words never appear in that order).
  assert.deepEqual(verifyComponentsInScript(script, [item]).missing, [item], 'substring alone would call it missing');
  // The planner's own assignment is the primary verdict.
  const assignments = componentAssignmentsFromPlan({ componentAssignments: [{ component: item, scene: 2 }] });
  assert.equal(assignments[item.toLowerCase()], 2);
  assert.deepEqual(verifyComponentsInScript(script, [item], assignments).missing, []);
});

test('2b: an assignment naming a scene that does not exist is NOT trusted', () => {
  const script = [scene(1, 'Only scene', 'One line.')];
  const assignments = componentAssignmentsFromPlan({ componentAssignments: [{ component: ITEM, scene: 9 }] });
  assert.deepEqual(verifyComponentsInScript(script, [ITEM], assignments).missing, [ITEM]);
});

test('2b: unassigned and unmentioned is still honestly missing', () => {
  const script = [scene(1, 'Only scene', 'One line.')];
  assert.deepEqual(verifyComponentsInScript(script, [ITEM], {}).missing, [ITEM]);
});

test('2b: the assignment map tolerates the shapes a model actually returns', () => {
  const fromArray = componentAssignmentsFromPlan({
    componentAssignments: [{ component: 'TikTok', sceneNumber: 1 }, { item: '$9.99', scene: 4 }],
  });
  assert.equal(fromArray['tiktok'], 1);
  assert.equal(fromArray['$9.99'], 4);
  const fromMap = componentAssignmentsFromPlan({ componentAssignments: { 'teal palette': 2 } });
  assert.equal(fromMap['teal palette'], 2);
  const fromScenes = componentAssignmentsFromPlan({ scenes: [{ sceneNumber: 3, covers: ['Follow @beadwick'] }] });
  assert.equal(fromScenes['follow @beadwick'], 3);
  assert.deepEqual(componentAssignmentsFromPlan(undefined), {});
});

// ─── 2c. one text-only repair pass ──────────────────────────────────────────
test('2c: the repair request is TEXT-ONLY and asks where the item goes', () => {
  const script = [scene(1, 'Establishing shot', 'Say hello.'), scene(2, 'The result', 'And here it is.')];
  const request = buildComponentRepairRequest({ items: [ITEM], script, voice: 'female' });
  assert.match(request, /hand-poured soy wax candle in a matte amber jar/, 'names the unplaced item');
  assert.match(request, /TEXT-ONLY/i, 'no media work');
  assert.match(request, /"placements"/);
  assert.match(request, /"script"/, 'the reply is wrapped so the router keeps it');
  assert.match(request, /scene 1/, 'shows the plan it must place into');
  assert.equal(/generate an image|render|veo|sora|audio/i.test(request), false, 'nothing here can buy a media call');
});

test('2c: a placement lands the item in the scene the planner named', () => {
  const script = [scene(1, 'Establishing shot', 'Say hello.'), scene(2, 'The result', 'And here it is.'), scene(3, 'Close', 'That is all.')];
  const repaired = applyComponentRepair(
    script,
    [ITEM],
    { script: { placements: [{ component: ITEM, scene: 2, narration: 'Every jar is poured by hand, soy wax in a matte amber jar.' }] } },
    { voice: 'female' },
  );
  assert.deepEqual(repaired.placed, [ITEM]);
  assert.deepEqual(repaired.stillMissing, []);
  assert.match(repaired.script[1].narration, /soy wax in a matte amber jar/);
  assert.equal(repaired.script[0].narration, 'Say hello.', 'other scenes are untouched');
});

test('2c: a placement into a scene that does not exist is refused, never invented', () => {
  const script = [scene(1, 'Establishing shot', 'Say hello.')];
  const repaired = applyComponentRepair(
    script,
    [ITEM],
    { script: { placements: [{ component: ITEM, scene: 7, narration: 'Soy wax, poured by hand.' }] } },
    { voice: 'female' },
  );
  assert.deepEqual(repaired.placed, []);
  assert.deepEqual(repaired.stillMissing, [ITEM]);
  assert.equal(script[0].narration, 'Say hello.');
});

test('2c: a silent video places into the visualPrompt, never into narration', () => {
  const script = [scene(1, 'Establishing shot', '')];
  const repaired = applyComponentRepair(
    script,
    [ITEM],
    { script: { placements: [{ component: ITEM, scene: 1, visualPrompt: 'The matte amber jar of hand-poured soy wax on a linen table' }] } },
    { voice: 'none' },
  );
  assert.deepEqual(repaired.stillMissing, []);
  assert.match(repaired.script[0].visualPrompt, /matte amber jar/);
  assert.equal(repaired.script[0].narration, '', 'a silent video has no voiceover to place into');
});

// ─── 2d. the gate, as the BACKSTOP ──────────────────────────────────────────
test('2d: what cannot be placed fails the row BEFORE any render, in the client\'s words', () => {
  const inventory = inventoryWith(ITEM);
  const planned = parseScenePlan({}, 'Ember & Oak candles', 30, 'scene');
  assert.equal(planned.length, 5, 'the template arc is the plan the client would otherwise get');

  // 2a/2b: the planner assigned nothing for this item.
  const assignments = componentAssignmentsFromPlan({ scenes: planned.map(s => ({ sceneNumber: s.sceneNumber })) });
  assert.deepEqual(verifyComponentsInScript(planned, inventory, assignments).missing, inventory);

  // 2c: the ONE repair pass came back empty (the model could not place it).
  const repaired = applyComponentRepair(planned, inventory, { script: { placements: [] } }, { voice: 'female' });
  assert.deepEqual(repaired.stillMissing, inventory, 'still unplaced after the repair pass');

  // The deterministic backstop paints it into a visualPrompt ...
  const painted = injectMissingComponents(repaired.script, inventory, {});
  assert.ok(painted.injected.length > 0, 'the backstop did run');

  // ... and for a VOICED video the F4 sanitiser strips inventory wording back out of
  // the stills (benefit text must never be painted), so it landed nowhere at all.
  const stripped = stripBenefitTextFromVisualPrompts(painted.script, inventory);
  const finalQc = { missingComponents: verifyComponentsInScript(stripped.script, inventory, assignments).missing };
  assert.deepEqual(finalQc.missingComponents, inventory, 'nothing was placed anywhere');

  const componentsFailure = componentsNotPlacedNotice(finalQc.missingComponents);
  assert.ok(componentsFailure, 'the gate fires');
  assert.equal(componentsFailure.code, COMPONENTS_NOT_PLACED_CODE);

  const outcome = resolveProjectCreationOutcome({
    planningFailure: null,
    componentsFailure,
    missingComponents: finalQc.missingComponents,
  });
  assert.equal(outcome.status, 'failed', 'the row is written as FAILED');
  assert.equal(outcome.startRender, false, 'and no render starts');
  assert.equal(outcome.componentsVerified, false);
  assert.deepEqual(outcome.componentsMissing, inventory);

  // The spy: createProject starts the worker only when the outcome says so.
  const started: string[] = [];
  if (outcome.startRender) started.push('processProject');
  assert.deepEqual(started, [], 'processProject is never called');

  // The client is told plainly, in the app's voice, naming what could not be placed.
  assert.match(componentsFailure.message, /We didn't make this video/);
  assert.match(componentsFailure.message, /hand-poured soy wax candle in a matte amber jar/, 'names the item');
  assert.match(componentsFailure.message, /Nothing was rendered/, 'and that nothing was bought');
  for (const word of ['planner', 'model', 'template', 'fallback', 'GPT', 'OpenAI', 'router', 'componentsVerified', 'COMPONENTS_NOT_PLACED', 'component']) {
    assert.equal(
      new RegExp(`\\b${word}\\b`, 'i').test(componentsFailure.message),
      false,
      `client copy must not say "${word}"`,
    );
  }
});

test('2d: a SILENT video that carries the item in the picture is NOT gated', () => {
  const inventory = inventoryWith(ITEM);
  const planned = parseScenePlan({}, 'Ember & Oak candles', 30, 'scene');
  const painted = injectMissingComponents(planned, inventory, {});
  // voice:'none' skips the visual sanitiser by design \u2014 the item is genuinely in the plan.
  const finalMissing = verifyComponentsInScript(painted.script, inventory, {}).missing;
  assert.deepEqual(finalMissing, [], 'the item is in the picture, so it is placed');
  assert.equal(componentsNotPlacedNotice(finalMissing), null, 'no gate');
  const outcome = resolveProjectCreationOutcome({ planningFailure: null, componentsFailure: null, missingComponents: [] });
  assert.equal(outcome.status, 'generating');
  assert.equal(outcome.startRender, true);
});

test('2d: a planning failure outranks a components failure (one row, one reason)', () => {
  const outcome = resolveProjectCreationOutcome({
    planningFailure: { code: 'PLANNING_FAILED', message: 'We didn\'t make this video.', detail: 'no plan' },
    componentsFailure: componentsNotPlacedNotice([ITEM]),
    missingComponents: [ITEM],
  });
  assert.equal(outcome.failure?.code, 'PLANNING_FAILED');
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.startRender, false);
});
