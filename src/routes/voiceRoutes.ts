/**
 * THE VOICE PICKER'S BACKEND (owner, 23 Nov).
 *
 *   GET /api/voices                       → the catalogue: gender → voices, tones,
 *                                           default card. NO paid call, no DB read.
 *   GET /api/voices/:voice/sample?tone=…  → ~4s of THAT voice in THAT tone as
 *                                           audio/mpeg, generated once and cached.
 *
 * Why the catalogue is a route and not a frontend constant: a voice we offer and
 * cannot speak is a promise we break, and the launch gate refuses a voice it does
 * not know. One list (`VOICE_CATALOGUE`) feeds the cards, the sample route's
 * validation, `resolveVoice` and the cost pre-flight, so they can never disagree.
 *
 * Both routes are unauthenticated like the rest of the API today (the root privacy
 * defect is known); the sample route is the only one that can spend, and it is
 * bounded to the catalogue's 11x5 combinations and refused during a render.
 */
import { Router } from 'express';

import { voiceCataloguePayload } from '../services/voiceOptions.js';
import { VOICE_SAMPLE_CONTENT_TYPE, VoiceSampleError, getVoiceSample } from '../services/voiceSampleService.js';

const router = Router();

/** The picker's catalogue. Free: it only reads the one list. */
router.get('/', (_req, res) => {
  res.json(voiceCataloguePayload());
});

/**
 * One voice's sample in one tone. `tone` is optional (defaults to 'auto', the
 * picker's default card), `voice` is not. An unknown voice or tone is a 400 with
 * the real list and costs nothing — never a silent swap for another voice.
 */
router.get('/:voice/sample', async (req, res) => {
  try {
    const tone = typeof req.query.tone === 'string' ? req.query.tone : undefined;
    const sample = await getVoiceSample(req.params.voice, tone);
    res
      .status(200)
      .type(VOICE_SAMPLE_CONTENT_TYPE)
      // The clip for a voice-tone never changes: let the browser keep it for a day
      // so replaying the cards costs nothing and needs no server round trip.
      .set('Cache-Control', 'public, max-age=86400')
      .send(sample.buffer);
  } catch (e: any) {
    const status = e instanceof VoiceSampleError ? e.status : 500;
    res.status(status).json({ status: 'error', error: e?.message || 'Voice sample failed' });
  }
});

export default router;
