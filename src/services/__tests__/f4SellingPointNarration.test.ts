import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCreativeEssence, finishedEssenceSentences, capNarrationForScene } from '../creativeTransformation.js';
import { verifySellingPointsSpoken, injectSellingPointsIntoNarration, stripBenefitTextFromVisualPrompts, verifyComponentsInScript, injectMissingComponents, buildPlannerComponentsSection, buildReplanFeedback, buildComponentInventory } from '../sceneVideoPipelineService.js';

/** OCT 10 owner brief — VERBATIM (the acceptance re-render #2 input). */
const OCT10_BRIEF = 'Introducing EmpireLaunch AI - Your go to content creation platform. Tired of spending hours editing all your videos, taking out word blobs or time gaps, this platform does that to! Make your life easier, save time and money. No more needing to purchase credits. Get started early with our introductory price. You get 76 video creations a month. For those of you that create designs for your business - you get 50 per month- cut you creation time down. Get started today - go to Empirelaunchai.com';

/** PROD-FAILING PLAN — the REAL acceptance re-render #2 script (project 992706c1,
 *  pulled verbatim from production Oct 10): 5 generic narrations carrying 0/7
 *  selling points, all 7 benefits dumped verbatim into scene-1's visualPrompt. */
const PROD_FAILING_PLAN = [
  { sceneNumber: 1, duration: 6, visualType: 'still', narration: "Say hello to EmpireLaunch AI. It's about to make things a lot easier.", visualPrompt: 'Cinematic establishing shot: hook intro of EmpireLaunch AI, the subject shown clearly for the first time — Save time and money. — Introductory price. — No more credit purchases. — 76 video creations a month. — 50 designs a month. — Go to Empirelaunchai.com. — Your go-to content creation platform.' },
  { sceneNumber: 2, duration: 6, visualType: 'still', narration: 'The essentials come together fast, and the process is simpler than it looks.', visualPrompt: 'Cinematic medium shot: setting up the fundamentals of EmpireLaunch AI, subject continues from the opening, early stage' },
  { sceneNumber: 3, duration: 6, visualType: 'still', narration: "And this is where it clicks — the transformation you came for.", visualPrompt: 'Cinematic wide shot: EmpireLaunch AI delivering its key benefit, the transformation in progress, same continuous subject' },
  { sceneNumber: 4, duration: 6, visualType: 'still', narration: "That's the payoff — real results, right in front of you.", visualPrompt: 'Cinematic close-up: the payoff result of EmpireLaunch AI, same continuous subject, breakthrough moment' },
  { sceneNumber: 5, duration: 6, visualType: 'still', narration: 'Ready to make the move? Tap the link in bio.', visualPrompt: 'Cinematic closing shot: EmpireLaunch AI final call-to-action, same continuous subject, confident ending' },
];

/** THE 8 FINISHED ESSENCE SENTENCES for the Oct 10 brief — subject + the 7 selling
 *  points (this is the SPOKEN MANDATE; it matches prod metadata.components 1:1). */
const { subject, benefits } = extractCreativeEssence(OCT10_BRIEF);
assert.equal(subject, 'EmpireLaunch AI', 'subject must be exactly the brand');
const sellingPoints = finishedEssenceSentences(extractCreativeEssence(OCT10_BRIEF));
const benefitsRelayed = benefits ?? [];
assert.equal(benefitsRelayed.length, 7, 'essence.benefits must carry all 7 selling points');

const SELLING_POINT_KEYS = sellingPoints.map(s => s.replace(/\.$/, '').toLowerCase());
const hasKey = (text: string, key: string) => String(text || '').toLowerCase().includes(key);

// ---------------------------------------------------------------------------
test('F4(a) real-route-shaped verify: prod-failing plan speaks 0/7 (bug repro)', () => {
  const missing = verifySellingPointsSpoken(PROD_FAILING_PLAN as any, sellingPoints as any).missing;
  // Of the 8 finished sentences, the brand "EmpireLaunch AI." IS spoken in scene 1 —
  // every one of the 7 SELLING POINTS must be missing (generic hook copy only).
  const keysMissing = missing.map(m => m.replace(/\.$/, '').toLowerCase());
  for (const key of SELLING_POINT_KEYS.slice(1)) {
    assert.ok(keysMissing.includes(key), `expected selling point "${key}" to be MISSING from narrations`);
  }
  assert.ok(!keysMissing.includes('empirelaunch ai'), 'brand sentence may be spoken');
});

// ---------------------------------------------------------------------------
test('F4(b) deterministic narration backstop: all 7 selling points are SPOKEN after injection', () => {
  const { script: fixed, injected, stillMissing } = injectSellingPointsIntoNarration(PROD_FAILING_PLAN as any, sellingPoints as any);
  // Every selling point must now appear in ≥1 narration.
  const haystack = fixed.map(s => s.narration).join(' ').toLowerCase();
  for (const key of SELLING_POINT_KEYS.slice(1)) {
    assert.ok(haystack.includes(key), `"${key}" must be SPOKEN after backstop`);
  }
  for (const p of injected) {
    assert.ok(haystack.includes(p.replace(/\.$/, '').toLowerCase()), `injected "${p}" must survive verbatim`);
  }
  assert.equal(stillMissing.length, 0, 'stillMissing must be empty after injection');
  // SHORT-narration hard rule must still hold on the final plan (cap idempotent).
  for (const s of fixed) {
    assert.equal(capNarrationForScene(s.narration, s.duration), s.narration, `scene ${s.sceneNumber} narration must respect the SHORT cap`);
  }
  // The already-spoken brand sentence must not be double-injected.
  assert.ok(!injected.some(p => /^EmpireLaunch AI\.$/i.test(p)), 'brand must not be re-injected');
  // CTA/price land in the FINAL scene; the positioning line lands in the hook.
  const last = fixed[fixed.length - 1].narration.toLowerCase();
  const hook = fixed[0].narration.toLowerCase();
  assert.ok(last.includes('introductory price'), 'price must be spoken in the FINAL scene');
  assert.ok(last.includes('empirelaunchai.com'), 'go-to-Empirelaunchai CTA must be spoken in the FINAL scene');
  assert.ok(hook.includes('go-to content creation platform') || hook.includes('go to content creation platform'), 'positioning must be spoken in the hook scene');
});

// ---------------------------------------------------------------------------
test('F4(c) visual-prompt BAN: the 7 benefit phrases are stripped from every visualPrompt (no-text stills)', () => {
  const { script: cleaned, strippedScenes } = stripBenefitTextFromVisualPrompts(PROD_FAILING_PLAN as any, sellingPoints as any);
  for (const s of cleaned) {
    const low = (s.visualPrompt || '').toLowerCase();
    for (const key of SELLING_POINT_KEYS.slice(1)) {
      assert.ok(!low.includes(key), `"${key}" must NEVER remain in scene ${s.sceneNumber} visualPrompt`);
    }
  }
  assert.ok(strippedScenes.includes(1), 'scene 1 (the planner-painted one) must be in the stripped audit');
  // The cleaned scene-1 prompt still names the SUBJECT (imagery) but no benefits.
  const s1 = cleaned[0].visualPrompt;
  assert.ok(/EmpireLaunch AI/i.test(s1), 'brand/subject reference may remain as imagery');
  assert.ok(/Cinematic/i.test(s1), 'scene-1 prompt must stay cinematic');
  // Narration is NEVER touched by the sanitizer.
  assert.equal(cleaned[1].narration, PROD_FAILING_PLAN[1].narration);
});

// ---------------------------------------------------------------------------
test('F4(d) composed launch-gate path: spoken + unstained + cap-held in one pass', () => {
  const spoke = injectSellingPointsIntoNarration(PROD_FAILING_PLAN as any, sellingPoints as any);
  const { script: final, strippedScenes } = stripBenefitTextFromVisualPrompts(spoke.script, sellingPoints as any);
  const haystack = final.map(s => s.narration).join(' ').toLowerCase();
  for (const key of SELLING_POINT_KEYS.slice(1)) assert.ok(haystack.includes(key));
  for (const s of final) {
    if (strippedScenes.includes(s.sceneNumber) === false) {
      const low = (s.visualPrompt || '').toLowerCase();
      for (const key of SELLING_POINT_KEYS.slice(1)) assert.ok(!low.includes(key));
    }
  }
  for (const s of final) assert.equal(capNarrationForScene(s.narration, s.duration), s.narration);
});

// ---------------------------------------------------------------------------
test('F4(e) idempotence: second injection pass is a no-op (no phantom duplication)', () => {
  const first = injectSellingPointsIntoNarration(PROD_FAILING_PLAN as any, sellingPoints as any);
  const second = injectSellingPointsIntoNarration(first.script, sellingPoints as any);
  assert.equal(second.injected.length, 0, 'already-complete plan must inject nothing');
  assert.equal(second.stillMissing.length, 0);
  assert.deepEqual(second.script.map(s => s.narration), first.script.map(s => s.narration));
});

// ---------------------------------------------------------------------------
test('F4(f) REAL createProject ordering: narration-first, then old visual backstop, then final strip — plan ends spoken + unstained', () => {
  // Exact order wired into createProject (Oct 10): planner output → F4 narration
  // injection (1920) → QC + old visual component backstop (1930/1938) →
  // content-direction → F4 visual prompt strip (2000). The old backstop may still
  // paint raw-inventory phrasing into visuals; the final F4 strip removes ALL
  // selling-point text from visualPrompts so the stills stay text-free.
  const spoke = injectSellingPointsIntoNarration(PROD_FAILING_PLAN as any, sellingPoints as any);
  assert.equal(spoke.stillMissing.length, 0);
  // Step 2: the OLD visual backstop with the REAL raw inventory (as createProject does).
  const rawInventory = buildComponentInventory({ components: [], cleanBrief: OCT10_BRIEF, conversation: [] });
  const afterBackstop = injectMissingComponents(spoke.script, rawInventory);
  // Step 3: final F4 visual strip (must clean whatever the backstop painted).
  const { script: final, strippedScenes } = stripBenefitTextFromVisualPrompts(
    afterBackstop.script,
    sellingPoints.filter(c => !/^EmpireLaunch AI\.$/i.test(c)),
  );
  // Launch-gate invariant: every selling point SPOKEN ...
  const haystack = final.map(s => s.narration).join(' ').toLowerCase();
  for (const key of SELLING_POINT_KEYS.slice(1)) assert.ok(haystack.includes(key), `"${key}" must be SPOKEN`);
  // ... and NO benefit text anywhere in the stills.
  for (const s of final) {
    const low = (s.visualPrompt || '').toLowerCase();
    for (const key of SELLING_POINT_KEYS.slice(1)) assert.ok(!low.includes(key), `"${key}" must never survive in scene ${s.sceneNumber} visualPrompt`);
  }
  assert.ok(strippedScenes.length >= 1, 'strip audit must record cleaned scenes');
  // Cap rule holds end-to-end.
  for (const s of final) assert.equal(capNarrationForScene(s.narration, s.duration), s.narration);
  // If any raw item was painted, it must be benefit phrasing (not, e.g., imagery words).
  for (const painted of afterBackstop.injected) {
    const k = painted.replace(/\.$/, '').toLowerCase();
    if (k === 'empirelaunch ai') continue; // subject named again is acceptable imagery
    assert.ok(SELLING_POINT_KEYS.slice(1).includes(k), `unexpected painted item "${painted}"`);
  }
});

// ---------------------------------------------------------------------------
test('F4(g) planner prompt hard rules: components must be SPOKEN, never painted', () => {
  const section = buildPlannerComponentsSection(sellingPoints as any, 'female');
  assert.ok(/SPOKEN/i.test(section), 'planner prompt must demand SPOKEN components');
  assert.ok(/NEVER put component\/benefit\/claim text into a visualPrompt/i.test(section), 'planner prompt must ban benefit text in visualPrompts');
  const feedback = buildReplanFeedback(sellingPoints as any, { hook: true, about: true, cta: true });
  assert.ok(/MISSING SPOKEN COMPONENTS/i.test(feedback), 'replan feedback must demand spoken components');
  assert.ok(/Never satisfy this by painting them into a visualPrompt/i.test(feedback));
  // voice:none keeps the visual-only contract (silent videos) — unchanged.
  const silent = buildPlannerComponentsSection(sellingPoints as any, 'none');
  assert.ok(/visualPrompt/i.test(silent));
});