import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * TWIN WIRE-LEVEL SOURCE CONTRACT (task 08041dff — owner Oct 19 ALL-MODES
 * directive; lead review finding 21:50Z).
 *
 * WHY THIS FILE EXISTS: the lead proved Twin runs a SEPARATE pipeline —
 * cinemaEngineService.createNeuralTwin → transformTwinScriptToPitch — that
 * never calls the shared planner/buildDictationSection (VideoProjectInput.mode
 * is typed only 'scene'|'faceless'; both twin callers go to createNeuralTwin).
 * The dictation-fidelity fix therefore must be WIRED DIRECTLY into the twin
 * engine. These tests read the production source and assert that wiring stays
 * present: if a future refactor removes the enforcement call (the exact
 * silent-drift failure mode the lead found), this suite breaks loudly.
 * Pure/static — no render, no API calls, no service instantiation (the
 * service imports ffmpeg/sharp/R2 and is not importable in the sandbox unit
 * path).
 */
const SERVICE_SRC = readFileSync(new URL('../../services/cinemaEngineService.ts', import.meta.url), 'utf8');

test('twin engine is architecturally separate (lead finding) — no shared-planner reach', () => {
  // Pins the architecture the wiring was built for: Twin never rides
  // buildPlannerRequest/createProject (sceneVideoPipelineService).
  assert.ok(!/buildPlannerRequest/.test(SERVICE_SRC), 'twin engine must not call buildPlannerRequest (separate pipeline)');
  assert.ok(!/createProject\s*\(/.test(SERVICE_SRC), 'twin engine must not call createProject (separate pipeline)');
  assert.ok(/transformTwinScriptToPitch/.test(SERVICE_SRC), 'twin engine keeps its own creative transformation');
});

test('twin path imports the shared requestedVisuals fidelity block', () => {
  assert.match(
    SERVICE_SRC,
    /import\s*\{\s*extractRequestedVisuals,\s*enforceTwinDictation,\s*userConversationText\s*\}\s*from\s*'\.\/requestedVisuals\.js';/,
    'cinemaEngineService must import extractRequestedVisuals + enforceTwinDictation + userConversationText'
  );
});

test('TwinCreationRequest carries conversation (dictation in prior turns is remembered)', () => {
  assert.match(
    SERVICE_SRC,
    /conversation\?:\s*\{\s*role\?:\s*string;\s*content\?:\s*unknown\s*\}\s*\[\]/,
    'TwinCreationRequest must accept an optional conversation array (owner Oct 19 "remember the conversation")'
  );
});

test('createNeuralTwin extracts requested visuals and ENFORCES them on the final script', () => {
  assert.match(
    SERVICE_SRC,
    /const\s+talkText\s*=\s*userConversationText\(conversation\);/,
    'conversation must be unioned via userConversationText'
  );
  assert.match(
    SERVICE_SRC,
    /const\s+requestedVisuals\s*=\s*extractRequestedVisuals\(talkText\s*\?\s*`\$\{script\}\s*\$\{talkText\}`\s*:\s*script\);/,
    'requested visuals must be extracted from script + conversation union'
  );
  assert.match(
    SERVICE_SRC,
    /const\s+enforced\s*=\s*enforceTwinDictation\(safeScript,\s*requestedVisuals\);/,
    'dictation enforcement must run AFTER transformTwinScriptToPitch on the cooked script'
  );
  assert.match(
    SERVICE_SRC,
    /const\s+finalTwinScript\s*=\s*enforced\.script;/,
    'the enforced script must be the twin deliverable'
  );
});

test('the enforced script (not the raw cooked pitch) feeds the twin downstream pipeline', () => {
  assert.match(
    SERVICE_SRC,
    /generateLipSyncReasoning\(finalTwinScript\)/,
    'lip-sync reasoning must read the ENFORCED script'
  );
  assert.match(
    SERVICE_SRC,
    /generateTalkingFrames\(\s*facialDna,\s*lipSyncData,\s*finalTwinScript,/,
    'talking frames must render the ENFORCED script text'
  );
  assert.match(
    SERVICE_SRC,
    /script:\s*finalTwinScript/,
    'metadata must record the enforced script'
  );
  assert.match(
    SERVICE_SRC,
    /twinDictationApplied:\s*enforced\.applied/,
    'metadata must record exactly which dictation guarantees were applied'
  );
});