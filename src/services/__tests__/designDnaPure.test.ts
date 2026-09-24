/**
 * designDnaPure — pure helper regression guards for the vault-DNA design
 * foundation bridge (task efe3ca14). The owner directive: harvested Canva DNA
 * from the Universal Vault must be the BASE FOUNDATION for client design
 * generation. These helpers are the deterministic part of that wiring —
 * normalizeArchetype maps platform archetype strings to the reasoner vocabulary,
 * extractNicheFromGoal pulls the niche from the platform's own records (backend
 * derives it, never expects it from the client), and buildDnaDirective turns the
 * StyleDNA + design reasoning into the prompt directive injected into GPT Image.
 * Type-only imports only — no DB, no langchain, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArchetype, extractNicheFromGoal, buildDnaDirective } from '../designDnaPure.js';

test('normalizeArchetype maps platform archetypes to reasoner vocabulary', () => {
  assert.equal(normalizeArchetype('SELLER'), 'creator');
  assert.equal(normalizeArchetype('seller'), 'creator');
  assert.equal(normalizeArchetype('CONTENT_CREATOR'), 'catalyst');
  assert.equal(normalizeArchetype('content_creator'), 'catalyst');
  assert.equal(normalizeArchetype('catalyst'), 'catalyst');
  // Unknown / empty → safe default creator (product-design persona)
  assert.equal(normalizeArchetype(''), 'creator');
  assert.equal(normalizeArchetype(null), 'creator');
  assert.equal(normalizeArchetype(undefined), 'creator');
  assert.equal(normalizeArchetype('marketing'), 'creator');
});

test('extractNicheFromGoal parses "Empire Niche:" marker, else falls back to title', () => {
  assert.equal(
    extractNicheFromGoal({ description: 'Empire Niche: Digital Planners. More detail here', title: 'Brand A' }),
    'Digital Planners'
  );
  // Missing marker → title fallback
  assert.equal(extractNicheFromGoal({ description: 'No niche marker in this description', title: 'My Brand' }), 'My Brand');
  // Empty goal → empty niche (caller skips DNA injection)
  assert.equal(extractNicheFromGoal(undefined), '');
  assert.equal(extractNicheFromGoal({ title: '' }), '');
});

test('buildDnaDirective produces a prompt directive carrying colors/fonts/tone + style direction', () => {
  const styleDna = {
    colors: ['#1a1a2e', '#16213e', '#0f3460'],
    fonts: ['Inter', 'Playfair Display'],
    pacing: 'moderate' as const,
    hooks: ['Stop scrolling if you want better planners', 'Transform your planning today'],
    keywords: ['planners', 'digital'],
    tone: 'professional',
  };
  const reason = {
    strategy: 'Vault Synthesis',
    reasoning: 'Using top-performing planner strands',
    templateStyle: 'Minimalist Professional',
    suggestedHooks: ['Hook A', 'Hook B', 'Hook C'],
    vaultStrandsUsed: ['strand-1', 'strand-2'],
  };
  const d = buildDnaDirective(styleDna, reason);
  assert.match(d, /#1a1a2e/);
  assert.match(d, /Playfair Display/);
  assert.match(d, /professional/);
  assert.match(d, /Minimalist Professional/);
  assert.match(d, /Hook A \| Hook B/);
  assert.match(d, /DESIGN FOUNDATION/);
});

test('buildDnaDirective tolerates missing hooks without crashing', () => {
  const styleDna = {
    colors: ['#fff'],
    fonts: ['Inter'],
    pacing: 'fast' as const,
    hooks: [],
    keywords: [],
    tone: 'playful',
  };
  const reason = {
    strategy: 'AI Generated',
    reasoning: 'fallback',
    templateStyle: 'Bold Creative',
    suggestedHooks: [],
    vaultStrandsUsed: [],
  };
  const d = buildDnaDirective(styleDna, reason);
  assert.match(d, /Bold Creative/);
  assert.ok(!/Hook\/CTA/.test(d));
});