/**
 * ONE place that resolves Etsy API credentials and builds the ONE header every
 * Etsy v3 request must carry.
 *
 * Measured live against `https://openapi.etsy.com/v3/application/listings/active`
 * with the owner's own values (23 Nov):
 *
 *   x-api-key: <keystring>              → 403 "Shared secret is required in x-api-key header."
 *   x-api-key: <keystring>:<secret>     → 200, real listings
 *
 * So a bare keystring can never work, and nothing outside this file may read the
 * Etsy environment variables — the owner's values are saved under names that read
 * oddly (her shared secret lives in ETSY_CLIENT_ID), and that mapping belongs in
 * exactly one place.
 */

export interface EtsyCredentials {
  /** The Etsy keystring (the public half of the API key). */
  keystring: string;
  /** The Etsy shared secret (the private half). */
  sharedSecret: string;
  /** True only when BOTH halves are present. A bare keystring is never "configured". */
  configured: boolean;
}

/** Shown to the client when Etsy cannot be called at all. Never a sign-in message. */
export const ETSY_NOT_CONFIGURED_REASON =
  'Etsy needs its keystring and shared secret saved as ETSY_API_KEYSTRING and ETSY_CLIENT_ID';

export class EtsyNotConfiguredError extends Error {
  readonly code = 'ETSY_NOT_CONFIGURED';
  constructor(message: string = ETSY_NOT_CONFIGURED_REASON) {
    super(message);
    this.name = 'EtsyNotConfiguredError';
  }
}

function read(name: string): string {
  return (process.env[name] || '').trim();
}

/**
 * Resolve the two halves of the Etsy key, in this order and nowhere else.
 *
 * Read at call time, never at import time: the values are operator settings and
 * a value that appears after this module loaded must still be honoured.
 */
export function resolveEtsyCredentials(): EtsyCredentials {
  const keystring = read('ETSY_API_KEYSTRING') || read('ETSY_CLIENT_ID');
  const sharedSecret =
    read('ETSY_CLIENT_SECRET') ||
    read('ETSY_API_SHARED_SECRET') ||
    (read('ETSY_API_KEYSTRING') ? read('ETSY_CLIENT_ID') : '');

  return {
    keystring,
    sharedSecret,
    configured: keystring.length > 0 && sharedSecret.length > 0,
  };
}

/** True when Etsy can actually be called (both halves present). */
export function isEtsyConfigured(): boolean {
  return resolveEtsyCredentials().configured;
}

/**
 * The one header builder. Every outbound Etsy request in this codebase takes its
 * headers from here — never a bare keystring, never a second copy of this logic.
 * Throws when Etsy is not configured rather than sending a request that must 403.
 */
export function buildEtsyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const { keystring, sharedSecret, configured } = resolveEtsyCredentials();
  if (!configured) throw new EtsyNotConfiguredError();
  return { ...extra, 'x-api-key': `${keystring}:${sharedSecret}` };
}
