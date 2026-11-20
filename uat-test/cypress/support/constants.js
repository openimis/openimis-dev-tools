// Shared constants used across the payment E2E suite.
//
// Keep this file small and focused on values that are referenced from more
// than one spec/command file.  Single-use values belong next to their caller.

export const CALC_RULES = {
  SOCIAL_PROTECTION: 'Calculation rule: social protection',
  TIMESHEET: 'Calculation rule: timesheet',
};

export const PAYROLL_STATUS = {
  PENDING_APPROVAL: 'PENDING APPROVAL',
  APPROVE_FOR_PAYMENT: 'APPROVE FOR PAYMENT',
  RECONCILED: 'RECONCILED',
  REJECTED: 'REJECTED',
};

export const PAYMENT_CYCLE_STATUS = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
};

export const TIMEOUTS = {
  // Async backend validation (e.g. code-uniqueness, custom filter resolution).
  BACKEND_VALIDATION: 5000,
  // Default Cypress defaultCommandTimeout override for flaky UI probes.
  SHORT_PROBE: 3000,
  // A list, journal entry or page that shows what the server returned after a search,
  // a save or a navigation: longer than the 5 s default for plain UI steps.
  SERVER_RESULT: 15000,
  // The first page of a session boots the whole app: over the network (a remote
  // server such as release.openimis.org) that takes well over 5 s.
  APP_LOAD: 30000,
};
