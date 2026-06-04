/**
 * Owner configuration for the EmpireLaunch AI system.
 * 
 * Used for system-level notifications, verification, and administrative access.
 * The owner email is referenced by notification services, the auth system,
 * and any administrative escalation paths.
 */
export const OWNER_CONFIG = {
  /** Primary owner email for system notifications and admin access */
  email: 'stacipeabody@gmail.com',

  /** Owner display name */
  name: 'Staci Peabody',

  /**
   * The tier key that grants owner-level access.
   * This bypasses all standard authorization checks.
   * Keep this value in sync with authController.ts.
   */
  masterKey: 'OWNER-ADMIN-MAX-ACCESS',

  /**
   * Whether to send a startup notification to the owner.
   * When true, the notification service emails the owner on system boot.
   */
  notifyOnStartup: true,
} as const;