/**
 * Owner configuration for the EmpireLaunch AI system.
 *
 * Used for system-level notifications, verification, and administrative access.
 * The owner email is referenced by notification services, the auth system,
 * and any administrative escalation paths.
 *
 * MASTER KEYS ARE NOT IN THIS FILE (owner decision, Nov 27: privacy first).
 * They used to be hardcoded here, which meant anyone with the repository — or
 * its history — could call `masterLogin` with the owner's email and become
 * OWNER_MASTER. That is a leaked credential, not a theoretical risk.
 *
 * Keys now come from the environment only:
 *   OWNER_MASTER_KEYS  comma-separated list, trimmed and upper-cased
 *   OWNER_EMAIL        the owner's address (defaults to the address already used)
 *
 * Unset means NO master key is accepted: master login refuses rather than
 * falling back to anything. The startup log says one line when it is unset and
 * never prints a value.
 */

/** Comma-separated env list → trimmed, upper-cased, non-empty entries. */
function keyListFromEnv(): string[] {
  const raw = process.env.OWNER_MASTER_KEYS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
}

export const OWNER_CONFIG = {
  /** Primary owner email for system notifications and admin access */
  email: process.env.OWNER_EMAIL || 'stacipeabody@gmail.com',

  /** Owner display name */
  name: 'Staci Peabody',

  /**
   * The tier key that grants owner-level access.
   * This bypasses all standard authorization checks.
   * Read from OWNER_MASTER_KEYS at call time; empty when unset (fail closed).
   */
  get masterKey(): string {
    return keyListFromEnv()[0] || '';
  },

  /**
   * Every accepted master key, from OWNER_MASTER_KEYS. Empty when unset, which
   * makes `allowedMasterKeys.includes(...)` false for every input — the fail-
   * closed behaviour we want.
   */
  get allowedMasterKeys(): string[] {
    return keyListFromEnv();
  },

  /**
   * Whether to send a startup notification to the owner.
   * When true, the notification service emails the owner on system boot.
   */
  notifyOnStartup: true,
};

if (keyListFromEnv().length === 0) {
  console.warn('[OwnerConfig] OWNER_MASTER_KEYS is unset — master login is refused.');
}
