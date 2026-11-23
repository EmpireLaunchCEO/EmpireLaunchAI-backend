/**
 * `GET /version` — what commit is serving, without guessing.
 *
 * Mounted at the app root, ahead of the rate limiter and every other route, so
 * the answer is reachable even from a client that has been throttled, and so no
 * future auth middleware can hide it. It has no dependencies beyond the
 * environment: no DB, no model, no network.
 *
 * It always answers 200. A missing `RAILWAY_GIT_COMMIT_SHA` is `"unknown"` — a
 * build probe that 404s or 500s tells you nothing, which is exactly the state
 * this route exists to end.
 */
import { Router } from 'express';

import { getVersionInfo, UNKNOWN_COMMIT } from '../services/versionInfo.js';

const versionRoutes = Router();

versionRoutes.get('/version', (_req, res) => {
  try {
    res.json(getVersionInfo());
  } catch {
    // Belt and braces: the probe must never be the thing that takes the app down.
    res.json({ commit: UNKNOWN_COMMIT, startedAt: new Date().toISOString(), uptimeSeconds: 0 });
  }
});

export default versionRoutes;
