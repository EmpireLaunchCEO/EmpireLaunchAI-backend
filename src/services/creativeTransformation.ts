/**
 * CREATIVE TRANSFORMATION LAYER (owner mandate, Sep 28 — task e4fddfab).
 *
 * The typed brief is RAW MATERIAL, NOT finished copy. The owner's videos kept
 * reciting her brief verbatim and showing "the making of" (the chat's internal
 * structure: "need 5 client beta testers", "5 compelling reasons", "CTA" cards).
 * PR #98 stopped literal plan-TEXT overlays and plan-speak narration, but the
 * transformation problem remained: the pipeline still treated the brief as
 * finished copy and mirrored internal talk-points into the final video.
 *
 * This module is the transformation layer. It is PURE — zero paid calls, zero
 * I/O — so it is unit-testable at the cheap layer (owner QA policy: no paid
 * renders while diagnosing).
 *
 * What it does:
 *  1. Detects INTERNAL-SOUNDING briefs (recruiting testers, list structure,
 *     CTA labels, meta talk about the video itself, "the making of").
 *  2. Extracts the CLIENT-FACING ESSENCE — product (what it is), audience
 *     (who it's for), offer/outcome (what it does for them).
 *  3. Rewrites the subject to a FINISHED client-facing subject (e.g.
 *     "New all in one- content creation, editing platform- need 5 client beta
 *     testers." → "the all-in-one content creation and editing platform").
 *  4. isInternalBriefEcho(): sibling to isPlanSpeakNarration — flags
 *     near-verbatim internal-brief echoes in narration so the pipeline can
 *     swap them for finished client-directed copy at the same last-mile spots.
 *  5. isInternalTalkPoint(): keeps recruiting/list/CTA-label meta OUT of the
 *     component inventory so injectMissingComponents never forces it into
 *     visualPrompts (the exact "5 compelling reasons" graphics the owner saw).
 */

export interface CreativeEssence {
  /** Finished, client-facing subject ("the all-in-one content creation and
   *  editing platform"). NEVER a raw internal fragment. */
  subject: string;
  /** Extracted product phrase, if found. */
  product?: string;
  /** Extracted audience phrase ("creators", "small business owners"...), if found. */
  audience?: string;
  /** Extracted offer/outcome ("20% off", "5 new templates"...), if found. */
  offer?: string;
  /** Normalized raw input (whitespace-collapsed). */
  raw: string;
  /** True when the brief was internal-sounding and needed rewriting. */
  internal: boolean;
  /** True when the DEGENERATE-OUTPUT guard fired and the subject was replaced
   *  by the compact rewrite fallback (raw brief echoed verbatim). */
  degenerateFallback?: boolean;
}

/** Internal-sounding brief markers: recruiting testers, list structure, CTA
 *  labels, and meta talk about the video itself. Matched against the raw brief
 *  BEFORE product extraction so we can cut everything from the first marker. */
const INTERNAL_BRIEF_MARKERS: RegExp[] = [
  // recruiting beta testers / participants
  /\bneed(?:s|ed)?\s+(?:\d+\s+)?(?:client\s+)?beta\s+testers?\b/i,
  /\blooking\s+for\s+(?:\d+\s+)?(?:client\s+)?beta\s+testers?\b/i,
  /\b(?:get|find|recruit(?:ing)?|hire(?:ing)?)\s+(?:\d+\s+)?(?:client\s+)?beta\s+testers?\b/i,
  /\bbeta\s+testers?\b/i,
  // list structure the owner explicitly banned ("5 compelling reasons" graphics)
  /\b\d+\s+compelling\s+reasons?\b/i,
  /\bcompelling\s+reasons?\b/i,
  /\b\d+\s+reasons?\b(?!\s+to\s+(?:love|enjoy)\b)/i, // "5 reasons to love" is client-facing; "5 reasons" as structure is not
  // CTA as a LABEL (a "CTA card" in the video) — real CTA wording like
  // "Follow @handle", "link in bio", "Subscribe" is NOT flagged.
  /\bcta\b/i,
  /\bcall\s*[- ]?\s*to\s*action\b/i,
  // meta talk about the video itself ("I want a video that…", "the video
  // should", "make me a video", "create a video about", "video idea")
  /\bi\s+(?:want|need|would\s+like)\s+(?:a|an|the)\s+video\b/i,
  /\bwe\s+(?:want|need)\s+(?:a|an|the)\s+video\b/i,
  /\bmake\s+me\s+a\s+video\b/i,
  /\bcreate\s+a\s+video\s+(?:about|for|that)\b/i,
  /\bthe\s+video\s+(?:should|will|would|needs|has\s+to)\b/i,
  /\ba\s+video\s+(?:should|will|would|needs|has\s+to)\b/i,
  /\bvideo\s+idea\b/i,
  // "the making of" — the owner's exact complaint
  /\b(?:the\s+)?making\s+of\b/i,
  /\bshow(?:ing)?\s+the\s+making\s+of\b/i,
  /\bbreakdown\s+of\s+the\s+chat\b/i,
  /\bnarration\s+of\s+the\s+chat\b/i,
  /\bbreakdown\s+of\s+the\s+brief\b/i,
];

/** Consultant/UI framing that must never reach narration or visuals. */
const CONSULTANT_FRAMING_MARKERS: RegExp[] = [
  /what\s+niche\s+should\s+we\s+dominate/i,
  /describe\s+the\s+vibe/i,
  /backgrounds,\s*motion\s+graphics,\s*overlays/i,
  /let(?:\u2019|'|’|‘)s\s+design\s+your\s+video/i,
  /one\s+quick\s+detail/i,
  /tap\s+the\s+wand\s+to\s+generate/i,
  /what(?:\u2019|'|’|‘)s\s+the\s+platform\s+name/i,
  /what\s+color\s+palette\s+should/i,
];

/** Audience extraction: "for creatives", "for small business owners", "for solo
 *  founders", "for designers" — the audience the pitch is directed at. */
const AUDIENCE_MARKERS: RegExp[] = [
  /\bfor\s+(?:the\s+)?(?:aspiring\s+|seasoned\s+|busy\s+|solo\s+|freelance\s+|small\s+business\s+)?(?:creators?|small\s+business\s+owners?|entrepreneurs?|founders?|designers?|marketers?|freelancers?|sellers?|shop\s+owners?|artists?|consultants?|agencies?|team(?:s)?|influencers?|solo\s+founders?)\b/i,
];

/** Offer/outcome extraction: "20% off", "$15", "5 new templates", "free trial",
 *  "save time", "double your sales", "grow faster". */
const OFFER_MARKERS: RegExp[] = [
  /\b\d{1,3}\s?%\s?off\b/i,
  /\$\s?\d+(?:[.,]\d+)?\b/,
  /\bfree\s+(?:trial|consult|demo|template|resources?)\b/i,
  /\b(?:save|cut|halve)\s+(?:time|money|costs?|hours?)\b/i,
  /\bdouble\s+(?:your\s+)?(?:sales|revenue|growth|conversions?)\b/i,
  /\bgrow(?:ing)?\s+(?:your\s+)?(?:business|brand|audience|following)\b/i,
];

/** Collapse whitespace + fold fancy quotes, for matching and for output. */
function normalize(text: unknown): string {
  return String(text || '')
    .replace(/\u2019|\u2018|'|’|‘/g, "'")
    .replace(/\u201C|\u201D|"|"|“|”/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Earliest index of ANY internal marker in `text`, or -1 when none match. */
/** Instruction/consultant residue that can leak into the TAIL of a typed brief
 *  ('Ok CTA- Get EmpireLaunch AI today and start creating more for less You
 *  choose Use a energetic mood across every scene and the narration.' — the
 *  EXACT residue the owner's Sep 30 brief carried, owner launch-gate task
 *  316d1a2f). Cut from the EARLIEST residue marker to the end so the residue
 *  can NEVER become the subject, a visual prompt, or narration. */
const INSTRUCTION_RESIDUE_PATTERNS: RegExp[] = [
  /\buse\s+a\s+[a-z]+(?:\s+mood)?\s+across\s+every\s+scene\b/i, // moodHintToString output
  /\b(?:cta|call\s+to\s+action)\b/i,                                // "CTA- Get ... today"
  /\byou\s+choose\b/i,                                                // "You choose"
  /(?:^|[.!?]\s+)ok\b/i,                                               // " Ok ..." sentence-start filler
  // OWNER-OCT-8 (5th failure, abca11ed): chat-REPLY residue — her typed brief
  // ended "...Introductory price! Yes Make sure it's cohesive and makes
  // customers want to get this app. Use a energetic mood across every scene and
  // the narration." The mood pattern alone fired LATER than the "Yes Make ..."
  // acknowledgment, so the recognizer's min-index cut kept the chat reply.
  // "Yes Make sure ..." / "Make sure it's cohesive" / "makes customers want"
  // are the owner's conversational directives, never client copy — cut at the
  // acknowledgment so the whole chat tail (incl. the mood sentence) is dropped.
  /\b(?:yes|yeah|sure|okay?)\s+make\s+sure\b/i,
  /\bmake\s+sure\s+it'?s\s+cohesive\b/i,
  /\bmakes\s+customers\s+want\s+to\s+get\b/i,
];
/** Strip trailing instruction/consultant residue from a raw brief (see the
 *  patterns above). Pure, deterministic — no LLM. */
export function stripInstructionResidue(raw: string): string {
  const t = normalize(raw);
  let cut = -1;
  for (const re of INSTRUCTION_RESIDUE_PATTERNS) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index >= 0) {
      // Keep a sentence separator the match consumed (e.g. ". Ok"): cut AFTER
      // the '.' / '!' / '?' so "Love this idea. Ok ..." keeps its period.
      const first = t[m.index] ?? '';
      const adj = first === '.' || first === '!' || first === '?' ? 1 : 0;
      cut = cut === -1 ? m.index + adj : Math.min(cut, m.index + adj);
    }
  }
  return cut === -1 ? t : t.slice(0, Math.max(0, cut)).trim();
}
/** Residue markers that indicate a DEGENERATE (untransformed) essence — the
 *  raw brief echoed verbatim rather than a compact finished subject. */
const DEGENERATE_ESSENCE_RESIDUE = /(?:^|\W)(?:cta|call\s+to\s+action)(?:\W|$)|(?:^|[.!?]\s+)ok\b|\bmood\s+across\s+every\s+scene\b|\byou\s+choose\b|\buse\s+a\s+[a-z]+\s+mood\b/i;
/** A subject (or product) longer than this is raw-brief residue, never a
 *  finished subject (task 316d1a2f: subject > ~200 chars => degenerate). */
export const ESSENCE_MAX_CHARS = 200;
/** True when the extracted subject/product is NOT compact — the raw brief was
 *  echoed verbatim (whole-brief subject, or residue markers like "CTA-"/"Ok"/
 *  "mood" leaked through). Triggers the compact rewrite fallback. */
export function isDegenerateEssenceOutput(subject: string, product?: string): boolean {
  const s = String(subject || '');
  const p = String(product || '');
  if (s.length > ESSENCE_MAX_CHARS) return true;
  if (DEGENERATE_ESSENCE_RESIDUE.test(s)) return true;
  if (p.length > ESSENCE_MAX_CHARS) return true;
  if (p && DEGENERATE_ESSENCE_RESIDUE.test(p)) return true;
  return false;
}
/** Count only real content tokens (ignores punctuation-only tokens like an
 *  em-dash surrounded by spaces). */
function contentTokens(s: string): number {
  return s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}
/** Genuinely compact rewrite (≤ ~10 content words) — the degenerate-echo
 *  fallback. Deterministic: takes the brand from 'Meet/Introducing/This is/
 *  Say hello to <Brand>' plus the short product clause after it; when no brand
 *  is found, keeps the leading noun phrase of the first sentence; last resort
 *  the neutral 'this all-in-one platform'. Never echoes the raw brief verbatim
 *  — bounded to ≤160 chars by construction. */
export function buildCompactSubject(raw: string): string {
  const t = stripInstructionResidue(normalize(raw));
  const brandMatch = t.match(/(?:^|[.!?]\s+)(?:meet|introducing|presenting|this\s+is|say\s+hello\s+to)\s+([A-Z][A-Za-z0-9'&+\-]*(?:\s+[A-Za-z0-9'&+\-]+){0,5})(?=[\s—–.,;:!?\-]|$)/i);
  if (brandMatch && brandMatch[1]) {
    const brand = brandMatch[1].trim().replace(/[—–\-]+$/g, '').trim();
    // OWNER OCT 9 subject bug: the brand regex used to swallow lowercase words
    // ("EmpireLaunch AI your go to platform") or capitalized possessive fragments
    // ("Your Go To platform") into the brand. Cut the brand at the first
    // possessive/stopword so the brand is the proper name only.
    const BRAND_STOP = /^(?:your|our|my|their|go|to|the|a|an|and|for|is|are|was|were|platform|app|tool|service|suite)$/i;
    const brandC = brand.split(/\s+/).filter((w) => !BRAND_STOP.test(w)).join(' ');
    const brandFinal = brandC || brand;
    if (contentTokens(brandFinal) <= 6 && brandFinal.length <= 60) {
      const tail = t.slice((brandMatch.index ?? 0) + brandMatch[0].length);
      const prodMatch = tail.match(/[—–\-]?\s*(?:the\s+)?(?!(?:your|our|my|their)\b)([a-z][a-z0-9'&.,\- ]{2,80}?)(?=\s+(?:built|for|designed|that|to|making|so|which)|\s*[.!?]|$)/i);
      if (prodMatch && prodMatch[1]) {
        // OWNER OCT 9 subject bug ("EmpireLaunch AI — the Your Go"): the capture
        // used to start on the lowercase inside a possessive ("Your" -> "our ..."),
        // swallowing a bullet fragment. Sanitize the finished subject here:
        // drop a leading possessive, normalize "go to"/"Go To" -> "go-to", and
        // refuse the subject if any bullet-fragment artifact survives.
        let prod = prodMatch[1].trim();
        prod = prod.replace(/^(?:your|our|my|their)\s+/i, '').trim();
        prod = prod.replace(/\bgo(?:\s+|-|—)*to\b/i, 'go-to').trim();
        if (/(?:^|\s)(?:your|our|my|their)\s+go\b/i.test(prod)) prod = prod.replace(/(?:^|\s)(?:your|our|my|their)\s+/i, ' ').trim();
        if (/^for\s+/i.test(prod)) prod = prod.replace(/^for\s+/i, 'platform for ').trim();
        prod = prod.replace(/[—–\-]+$/g, '').trim();
        if (prod.length < 4 || /^go\b/i.test(prod)) return brand.length <= 60 ? brand : 'this all-in-one platform';
        const subject = `${brandFinal} — the ${prod}`;
        if (contentTokens(subject) <= 12 && subject.length <= 160 && !/(?:— the )(?:your|our|my|their)\b/i.test(subject)) return subject;
      }
      if (brandFinal.length <= 60) return brandFinal;
    }
  }
  const firstSentence = (t.split(/(?<=[.!?])\s+/)[0] || t).trim();
  const lead = firstSentence.split(/\s+/).slice(0, 8).join(' ').replace(/\bgo(?:\s+|-)*to\b/i, 'go-to');
  if (lead.length >= 4 && lead.length <= 80 && contentTokens(lead) <= 8 && !/^(?:the|a|an|this|that|it|we|i|you|they)\s*$/i.test(lead) && !/\b(?:your|our|my|their)\s+[a-z]/i.test(lead)) return lead;
  return 'this all-in-one platform';
}
/** HARD NARRATION LENGTH CAP (task 316d1a2f): a ~6s scene slot can carry only
 *  ~15 words / ~120 chars of TTS. Scales down with the scene duration; floors
 *  at 8 words / 48 chars so micro-scenes still read as real copy. Word-boundary
 *  truncation — never mid-word. Applied at the last-mile planning sites so
 *  Scene 1 can NEVER be a 215-char brief dump. */
export const NARRATION_MAX_CHARS = 120;
export const NARRATION_MAX_WORDS = 15;
export function capNarrationForScene(text: string, durationSec = 6): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return t;
  const dur = Math.max(2, Number(durationSec) || 6);
  const maxWords = Math.max(8, Math.min(NARRATION_MAX_WORDS, Math.round(dur * 2.5)));
  const maxChars = Math.max(48, Math.min(NARRATION_MAX_CHARS, Math.round(dur * 20)));
  // Count CONTENT tokens only (an em-dash or comma surrounded by spaces is
  // punctuation, not a word, so it never consumes a speech slot).
  const tokens = t.split(' ');
  let keep = tokens.length;
  let content = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (/[A-Za-z0-9]/.test(tokens[i])) content++;
    if (content > maxWords) { keep = i; break; }
  }
  let out = tokens.slice(0, keep).join(' ')
    .replace(/(?:\s+[—–-])+$/g, '')
    .trim();
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    out = lastSpace > Math.floor(maxChars * 0.5) ? cut.slice(0, lastSpace) : cut;
  }
  // SENTENCE-COMPLETENESS (owner Oct 8 — FAILED 5th re-test): the word/char cap
  // used to slice mid-thought, leaving dangling fragments like "Say hello to
  // Introducing EmpireLaunch AI, the platform for all you need. — it's" spoken
  // and painted in the video. When the capped text contains a completed sentence
  // before its truncation point, cut back to the LAST sentence boundary inside
  // the limit so the delivered line is a complete, natural sentence — never a
  // mid-sentence fragment with a trailing dash/wrap. Only when NO punctuation
  // boundary exists (a single overlong run-on) do we keep the raw word-cut.
  const boundary = /[.!?](?:['”’"])?\s*$/;
  // OWNER-OCT-8 HARDENING: this correction previously only ran when the line
  // was actually truncated (t.length > out.length), so a SHORT in-cap dangling
  // line (prod: "Say hello to Introducing EmpireLaunch AI, the platform for
  // all you need. — it's" = 13 words in a 6s scene) passed uncorrected.
  // The completeness fix now applies to EVERY narration line that does not
  // already end on a sentence boundary.
  if (!boundary.test(out)) {
    const prefix = out.replace(/[—–\-]+$/g, '').trim();
    // Find the last sentence end strictly inside the (dash-trimmed) prefix.
    // `\s+|$` also matches a boundary at the very end (no trailing space).
    let cutAt = -1;
    const re = /[.!?](?:['”’"])?(?:\s+|$)/g;
    let mm;
    while ((mm = re.exec(prefix)) !== null) {
      if (mm.index + mm[0].length <= prefix.length) cutAt = mm.index + mm[0].length;
    }
    if (cutAt > Math.floor(prefix.length * 0.35)) {
      out = prefix.slice(0, cutAt).trim();
    } else {
      // No early boundary — keep the word-cut (unavoidable run-on), but never
      // end on a trailing dash or orphan wrap token.
      out = out.replace(/[—–\-]+$/g, '').trim();
    }
  }
  return out.trim();
}
export function firstInternalMarkerIndex(text: string): number {
  const t = normalize(text);
  let found = -1;
  for (const re of INTERNAL_BRIEF_MARKERS) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index >= 0) {
      found = found === -1 ? m.index : Math.min(found, m.index);
    }
  }
  return found;
}

/** Earliest index of any consultant/UI framing marker, or -1. */
function firstConsultantMarkerIndex(text: string): number {
  const t = normalize(text);
  let found = -1;
  for (const re of CONSULTANT_FRAMING_MARKERS) {
    const m = t.match(re);
    if (m && m.index !== undefined && m.index >= 0) {
      found = found === -1 ? m.index : Math.min(found, m.index);
    }
  }
  return found;
}

/** True when the raw brief is internal-sounding (recruiting testers, list
 *  structure, CTA labels, meta talk about the video itself). */
export function isInternalSoundingBrief(raw: string): boolean {
  return firstInternalMarkerIndex(raw) !== -1;
}

/** Polish a raw product fragment into a finished noun phrase:
 *  "New all in one- content creation, editing platform-" →
 *  "all-in-one content creation, editing platform". */
function polishProductFragment(frag: string): string {
  let s = normalize(frag);
  // Strip leading marketing filler + articles.
  s = s.replace(/^(?:new|introducing|brand[_ -]?new|check\s+out|meet|presenting)\s+/i, '').trim();
  s = s.replace(/^(?:the|a|an)\s+/i, '').trim();
  // "all in one" / "all-in-1" / "all-in-one" → canonical "all-in-one".
  s = s.replace(/\ball\s+in\s+one\b/i, 'all-in-one').trim();
  // The owner's briefs join clauses with a bare dash+space ("all in one- content
  // creation") — treat space-delimited dashes as separators, not hyphenation
  // (legit compounds like "small-business" have no spaces and are preserved).
  s = s.replace(/\s*[-–—]\s+/gi, ' ').trim();
  // Any remaining em/en-dash glued to a word is a separator too (trailing or
  // clause-join), except it must not destroy real hyphenated compounds: only
  // touch dashes that border a space or sit at the very end.
  s = s.replace(/[-–—]+\s+|\s+[-–—]+/gi, ' ').trim();
  // Drop a trailing separator / particle ("platform-", "platform,").
  s = s.replace(/[,;:–—-]+$/g, '').trim();
  // Join a short trailing clause after a comma with "and" so the subject reads
  // as a finished pitch ("content creation, editing platform" →
  // "content creation and editing platform"); keep multi-clause lists as-is.
  s = s.replace(/,\s+([a-z][a-z ]{1,28}[a-z])\s*$/i, ' and $1').trim();
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

/** Extract the audience ("creators", "small business owners"...) from the brief. */
function extractAudience(raw: string): string | undefined {
  const t = normalize(raw);
  for (const re of AUDIENCE_MARKERS) {
    const m = t.match(re);
    if (m && m[0]) {
      // "for creators" → "creators"
      return normalize(m[0]).replace(/^for\s+(?:the\s+)?/i, '').trim() || undefined;
    }
  }
  return undefined;
}

/** Extract the offer/outcome ("20% off", "save time"...) from the brief. */
function extractOffer(raw: string): string | undefined {
  const t = normalize(raw);
  for (const re of OFFER_MARKERS) {
    const m = t.match(re);
    if (m && m[0]) return normalize(m[0]);
  }
  return undefined;
}

/** True when a product fragment is degenerate (just a pronoun/verb/particle
 *  remnant like "We're", "I'm", "the", "looking", "want" — not a real product). */
function isDegenerateProductFragment(s: string): boolean {
  const t = s.toLowerCase().trim();
  if (!t || t.length < 4) return true;
  return /^(we'?re|we are|i'?m|i am|i want|i need|we want|we need|looking|need|want|to|for|the|a|an|and|that|this|it's?|its?|new)\b/.test(t) && !/\s/.test(t);
}

/** Last-resort product scan: when cutting at the first internal marker leaves no
 *  product (brief begins with the marker, e.g. "I want a video that shows my
 *  candle business"), find the real product clause ANYWHERE in the raw text. */
function tailScanProduct(raw: string): string | undefined {
  const t = normalize(raw);
  // Scan on the text AFTER the last internal marker only — the head already
  // failed, so the product lives behind the recruiting/list/meta talk.
  const markers = [...t.matchAll(/(?:need(?:s|ed)?|looking\s+for|recruit|hire|want|make\s+me|create)\s+(?:\d+\s+)?(?:client\s+|beta\s+)?testers?|\b\d+\s+compelling\s+reasons?\b|\bcta\b|\bmaking\s+of\b|\bbreakdown\s+of\s+the\s+chat\b|\bi\s+(?:want|need|would\s+like)\s+(?:a|an|the)\s+video\b|\bwe(?:'|'|’|‘)re\s+looking\s+for\b/gi)];
  const fromIdx = markers.length ? (markers[markers.length - 1].index ?? 0) + (markers[markers.length - 1][0]?.length ?? 0) : 0;
  const tail = t.slice(fromIdx).trim();
  const candidates: string[] = [];
  for (const m of tail.matchAll(/\b(?:about|for|showing|that (?:shows?|features?|offers?))+\s+(?:the\s+|my\s+|our\s+|your\s+)?([A-Za-z][A-Za-z0-9'&.\- ]{2,60})/gi)) {
    if (m[1] && m.index !== undefined) candidates.push(m[1]);
  }
  // Last, longest candidate ("for our new app" → "our new app").
  const best = candidates.sort((a, b) => b.length - a.length)[0];
  if (!best) return undefined;
  // Light cleanup only (keep "new app" — a real product noun — and strip a
  // leading possessive/definite article so the finished subject reads naturally).
  let p = normalize(best);
  p = p.replace(/^(?:the|a|an|my|our|your)\s+/i, '').trim();
  p = p.replace(/[,;:–—-]+$/g, '').trim();
  return p.length >= 3 ? p : undefined;
}

/** Derive the CLIENT-FACING ESSENCE from a raw brief. The subject is always a
 *  FINISHED noun phrase directed at the audience — when the brief is
 *  internal-sounding we REWRITE it (never the raw fragment); when it is not we
 *  keep the first sentence (existing compactCreativeSubject behavior). */
export function extractCreativeEssence(rawBrief: string): CreativeEssence {
  const full = normalize(rawBrief);
  // Strip instruction/consultant residue ('Ok CTA- Get …today…', mood hints)
  // FIRST so it can never be cut into the product head and echoed as the
  // finished subject (the owner's Sep 30 degenerate extraction).
  const t = stripInstructionResidue(full);
  const consultantIdx = firstConsultantMarkerIndex(t);
  const internalIdx = firstInternalMarkerIndex(t);
  const internal = internalIdx !== -1;

  // Cut consultant framing FIRST (it precedes any real brief text).
  let subjectSource = t;
  if (consultantIdx !== -1) subjectSource = t.slice(0, consultantIdx).trim();

  // If the brief is internal-sounding, cut at the first internal marker: only
  // the text BEFORE it can describe the product. "New all in one- content
  // creation, editing platform- need 5 client beta testers." → product part is
  // "New all in one- content creation, editing platform-".
  if (internalIdx !== -1) subjectSource = subjectSource.slice(0, internalIdx).trim();

  let product = polishProductFragment(subjectSource);
  if (isDegenerateProductFragment(product)) {
    // The head before the marker was pure meta ("I want a video that shows my
    // candle business" → head is empty). Salvage the real product from the tail.
    const salvaged = tailScanProduct(t);
    product = salvaged ?? '';
  }
  const hasProduct = product.length >= 4 && !isDegenerateProductFragment(product);
  const audience = extractAudience(subjectSource) || extractAudience(t);
  const offer = extractOffer(subjectSource) || extractOffer(t);

  // Finished subject: "the <product>" — never the raw internal fragment.
  let subject: string;
  if (internal) {
    subject = hasProduct ? `the ${product}` : 'this all-in-one platform';
  } else {
    // Not internal-sounding: keep the first sentence (finished-as-typed).
    const firstSentence = (t.split(/(?<=[.!?])\s+/)[0] || t).trim();
    subject = firstSentence || 'this upgrade';
  }

  // DEGENERATE-OUTPUT GUARD (task 316d1a2f): if the finished subject/product
  // is not compact (whole-brief echo, residue markers), fall back to a
  // genuinely compact rewrite (≤ ~10 words, essence of product/audience/offer).
  // The raw brief must NEVER flow into visual prompts or narration.
  let degenerateFallback = false;
  if (isDegenerateEssenceOutput(subject, product)) {
    const compact = buildCompactSubject(full);
    subject = compact;
    product = compact;
    degenerateFallback = true;
  }
  return { subject, product: hasProduct ? product : undefined, audience, offer, raw: full, internal, degenerateFallback };
}

/** Finished-subject view used by compactCreativeSubject (respects maxChars). */
export function finishedCreativeSubject(rawBrief: string, maxChars = 160): string {
  const { subject, internal } = extractCreativeEssence(rawBrief);
  if (!internal) {
    // Non-internal brief: keep existing first-sentence + truncation semantics.
    return subject.length <= maxChars ? subject : `${subject.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return subject.length <= maxChars ? subject : `${subject.slice(0, maxChars - 1).trimEnd()}…`;
}

/** CONTENT TRANSFORMATION (owner Sep 28): sibling to isPlanSpeakNarration.
 *  Flags near-verbatim INTERNAL-BRIEF echoes — recruiting testers, list
 *  structure ("5 compelling reasons"), CTA labels, meta talk about the video
 *  itself, "the making of" — so the pipeline can swap them for finished
 *  client-directed copy at the same last-mile sites (parseScenes + GPT-Audio).
 *  Deliberate user LINE_CHANGE edits are exempt upstream (allowPlanSpeak) and
 *  stay voiced verbatim. */
export function isInternalBriefEcho(text: string | null | undefined): boolean {
  const t = normalize(text);
  if (!t) return false;
  if (/\bneed(?:s|ed)?\s+(?:\d+\s+)?(?:client\s+)?beta\s+testers?\b/i.test(t)) return true;
  if (/\blooking\s+for\s+(?:\d+\s+)?(?:client\s+)?beta\s+testers?\b/i.test(t)) return true;
  if (/\b(?:get|find|recruit(?:ing)?|hire(?:ing)?)\s+(?:\d+\s+)?(?:client\s+)?beta\s+testers?\b/i.test(t)) return true;
  if (/\bbeta\s+testers?\b/i.test(t)) return true;
  if (/\b\d+\s+compelling\s+reasons?\b/i.test(t)) return true;
  if (/\bcompelling\s+reasons?\b/i.test(t)) return true;
  // List-recital narration ("here are the 5 reasons...") — reciting a numbered
  // list-structure the owner banned. Plain "5 reasons to love X" stays.
  if (/\b(?:here\s+are|here'?s|these\s+are|let\s+me\s+show\s+you|we'?ll\s+show\s+you)\s+(?:the\s+)?\d+\s+reasons?\b/i.test(t)) return true;
  // "CTA"/"call to action" as a LABEL (a card/placeholder in the video) — never
  // render it; real CTA wording ("Follow @handle", "link in bio") is untouched.
  if (/\bcta\b/i.test(t)) return true;
  if (/\bcall\s*[- ]?\s*to\s*action\b/i.test(t) && !/\blink\s+in\s+bio\b/i.test(t)) return true;
  if (/\bi\s+(?:want|need|would\s+like)\s+(?:a|an|the)\s+video\b/i.test(t)) return true;
  if (/\bwe\s+(?:want|need)\s+(?:a|an|the)\s+video\b/i.test(t)) return true;
  if (/\bmake\s+me\s+a\s+video\b/i.test(t)) return true;
  if (/\bcreate\s+a\s+video\s+(?:about|for|that)\b/i.test(t)) return true;
  if (/\b(?:the|a)\s+video\s+(?:should|will|would|needs|has\s+to)\b/i.test(t)) return true;
  if (/\bvideo\s+idea\b/i.test(t)) return true;
  if (/\b(?:the\s+)?making\s+of\b/i.test(t)) return true;
  if (/\bshow(?:ing)?\s+the\s+making\s+of\b/i.test(t)) return true;
  if (/\bbreakdown\s+of\s+the\s+(?:chat|brief)\b/i.test(t)) return true;
  if (/\bnarration\s+of\s+the\s+chat\b/i.test(t)) return true;
  return false;
}

/** True when an inventory candidate is INTERNAL TALK (recruiting, list
 *  structure, CTA label, meta) and must NOT be forced into scenes as a
 *  component. Real relayed components (platforms, colors, prices, real CTA
 *  wording like "Follow @handle" / "link in bio") are never flagged. */
export function isInternalTalkPoint(item: string): boolean {
  const t = normalize(item);
  if (!t) return true;
  // Real, concrete CTA wording is client-facing — never block it.
  if (/\b(?:follow|subscribe|comment|share|save|dm|sign\s+up|join|link\s+in\s+bio|shop\s+now|learn\s+more|get\s+yours|act\s+now)\b/i.test(t)) return false;
  return isInternalBriefEcho(t);
}

/** CHAT/INSTRUCTION RESIDUE GUARD (owner launch-gate Oct 8 — FAILED 5th re-test):
 *  True when a candidate component/narration is chat-tone or an internal
 *  instruction that must NEVER be voiced or painted: conversational filler
 *  ("Yes Make sure it's cohesive..."), mood/stage instructions ("Use a energetic
 *  mood across every scene and the narration."), and assistant chat replies
 *  ("I love the energy, but I'm here to chat with anything you need..."). These
 *  are the exact residue chunks that leaked into metadata.components and were
 *  injected VERBATIM into scene visualPrompts on Oct 8 (project abca11ed). */
export function isChatResidueText(item: string | null | undefined): boolean {
  const t = String(item || '').replace(/\u2019/g, "'").replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/(?:^|[.!?]\s+)(?:yes|ok|okay|no problem|sure|great|awesome|perfect)\b/i.test(t)) return true;
  if (/\bmake\s+sure\s+it'?s\s+(?:cohesive|coherent|consistent|polished|look\s+good)\b/i.test(t)) return true;
  if (/\buse\s+a\s+[a-z]+\s+mood\s+across\s+every\s+scene\b/i.test(t)) return true;
  if (/\bacross\s+every\s+scene\s+and\s+the\s+narration\b/i.test(t)) return true;
  if (/\b(?:i\s+love|love\s+the)\s+energy\b/i.test(t)) return true;
  if (/\bi'?m\s+here\s+to\s+chat\b/i.test(t)) return true;
  if (/\byou\s+choose\b/i.test(t)) return true;
  if (/\b(?:cta|call\s+to\s+action)\b/i.test(t)) return true;
  return false;
}
/** VERBATIM READ-BACK instruction for gpt-audio (a CHAT model). Without it the
 *  model treats the narration line as a conversation prompt and can reply with
 *  its own chat-tone words ("I love the energy, but I'm here to chat with
 *  anything you need to chat about" — the second voice the owner heard on the
 *  Oct 8 re-test). This command forces it to speak ONLY the provided script. */
export function ttsReadAloudInstruction(tone?: 'enthusiastic' | 'calm' | 'serious' | 'warm' | 'auto'): string {
  const toneDir = tone === 'calm' ? 'a calm, steady, reassuring delivery'
    : tone === 'serious' ? 'a serious, confident, professional delivery'
    : tone === 'warm' ? 'a warm, friendly, inviting delivery'
    : tone === 'enthusiastic' ? 'bright, energetic enthusiasm'
    : 'a natural, lively, engaging delivery';
  return `You are a text-to-speech narrator. Read the user's text EXACTLY as written, word for word. Do not add, remove, rephrase, expand, explain, or respond conversationally — never speak anything beyond the provided text. Use ${toneDir}.`;
}
/** Rewrite an INTERNAL-sounding twin script into a finished client-directed
 *  pitch built from the essence. Finished copy (no internal markers) is kept
 *  verbatim — a user's own authored script is authoritative (mirrors the
 *  LINE_CHANGE carve-out). */
export function transformTwinScriptToPitch(script: string): string {
  const essence = extractCreativeEssence(script);
  // OWNER-OCT-8 (5th failure, extended to Twin by lead scope): the typed brief
  // is RAW MATERIAL — rewrite not only INTERNAL-sounding scripts but also
  // DEGENERATE whole-brief echoes (internal:false + degenerateFallback:true,
  // the exact classification of the owner's Oct 8 brief) and any script that
  // still carries chat/instruction residue. Otherwise Twin voiced/painted her
  // typed brief verbatim. Finished user scripts (clean, non-degenerate, no
  // residue) stay verbatim.
  const t = String(script || '').replace(/\s+/g, ' ').trim();
  if (!essence.internal && !essence.degenerateFallback && !isChatResidueText(t)) return normalize(script);
  const parts: string[] = [`This is ${essence.subject}.`];
  if (essence.offer) {
    parts.push(`${cap(essence.offer)} — right now.`);
  } else {
    parts.push('It handles the busywork so you can focus on what matters.');
  }
  if (essence.audience) {
    parts.push(`Built for ${essence.audience}.`);
  } else {
    parts.push('Built for people who want real results.');
  }
  parts.push('Ready to make the move? Tap the link.');
  return parts.join(' ');
}

/** Build the planner prompt HARD-RULE section: the brief is raw material, the
 *  video is a FINISHED PITCH derived from the client-facing essence. */
export function buildTransformationPlannerRule(): string {
  return "\n\nCREATIVE TRANSFORMATION (mandatory): the user's typed brief is RAW MATERIAL — do NOT quote it verbatim anywhere, and NEVER depict its structure or 'the making of' (no '5 compelling reasons' list graphics, no 'CTA' cards, no recitals of what the user typed, no step-by-step of the planning or chat breakdown). Derive the client-facing essence — the PRODUCT (what it is), the AUDIENCE (who it's for), the OFFER/OUTCOME (what it does for them) — from the brief and conversation, then plan every scene as a FINISHED PITCH to that audience: audience problem → product solving it → outcome. RELAY THE BRIEF'S CONCRETE BENEFITS as polished client copy in the narration — e.g. 'all-in-one creation, editing and design', 'stop paying for single-purpose apps', 'save time and money', 'build and scale your brand', 'introductory price' — do NOT drop or abstract them away; rewrite them as customer-facing sentences (never quote the typed brief verbatim). If the raw brief is internal-sounding ('need beta testers', '5 compelling reasons', 'CTA', 'I want a video that…', 'we're looking for'), ignore it as a script and pitch the finished product instead.";
}

function cap(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}