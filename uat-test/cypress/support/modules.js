// Solution-aware runs (README, "Running against a solution").
//
// Every spec declares the openIMIS modules it exercises in a header line:
//   // @modules be: social_protection, individual  fe: SocialProtectionModule, IndividualModule
// The solution builder reads these headers and writes the specs a solution can run
// into its uat.json; `run-uat.mjs --solution uat.json` runs those specs only and
// passes the solution's modules (backend and frontend names, comma separated) to
// Cypress as the env UAT_MODULES.
//
// A test that needs more than its spec declares calls requireModules() first:
//   it('Downloads the master data (OCM-703)', () => {
//     requireModules('tools', 'ToolsModule');
//     ...
//   });
// Called from a before()/beforeEach() hook, it skips every test of the describe.
// Without UAT_MODULES (the full UAT stack), nothing is skipped.

// Marker appended to the title of a test skipped for a missing module; run-uat.mjs
// reads it to report the test as "not in solution" instead of as a plain skip.
export const NOT_IN_SOLUTION = '[not in solution:';

// The modules of the solution under test, or null when UAT_MODULES is not set.
export function uatModules() {
  const raw = Cypress.env('UAT_MODULES');
  if (raw === undefined || raw === null || raw === '') return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return new Set(list.map((name) => String(name).trim()).filter(Boolean));
}

// The names among `names` that the solution under test does not have.
export function missingModules(...names) {
  const installed = uatModules();
  return installed ? names.flat().filter((name) => !installed.has(name)) : [];
}

// Skips the current test (or, from a hook, the tests of its describe) when the
// solution under test lacks one of the modules. Call it before any cy command.
export function requireModules(...names) {
  const missing = missingModules(...names);
  if (!missing.length) return;
  const runnable = cy.state('runnable');
  const marker = ` ${NOT_IN_SOLUTION} ${missing.join(', ')}]`;
  const mark = (test) => {
    if (!test.title.includes(NOT_IN_SOLUTION)) test.title += marker;
  };
  if (runnable.type === 'hook') runnable.parent.eachTest(mark);
  else mark(runnable);
  runnable.ctx.skip();
}
