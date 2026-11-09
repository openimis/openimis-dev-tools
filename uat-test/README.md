# openIMIS UAT runner

Runs the openIMIS UAT suite (TestLink project, ids `OCM-<externalid>`) against a
running openIMIS instance and writes a report with the result and duration of every
UAT case.

The Cypress specs and commands are seeded from
[openimis-dist_dkr `develop`/cypress](https://github.com/openimis/openimis-dist_dkr/tree/develop/cypress)
(commit in `.upstream-commit`); fixes made here belong upstream as well.

## Run

The suite runs against a **UAT stack** next to the regular dev stack (:3000 → :8000).
The database can be the openIMIS demo dataset or an empty one (schema, `Admin`, and
the reference lists only). Specs do not read demo records. Before each spec,
`scripts/baseline.mjs` fetches or creates a separate baseline whose codes start with `BL`.

```bash
npm install
scripts/setup-demo-db.sh            # once: creates and migrates demo_imis (--force recreates)
scripts/setup-demo-db.sh --empty    # same, without demo_db.sql (database empty_imis)
scripts/start-uat-stack.sh          # backend :8001 on demo_imis, frontend :3001 (Ctrl-C stops)
npm run uat                         # whole suite against http://localhost:3001
node scripts/run-uat.mjs --parallel 3   # same, up to 3 specs at a time (see below)
node scripts/run-uat.mjs --spec cypress/e2e/auth.cy.js
node scripts/run-uat.mjs --base-url http://localhost        # docker stack (openimis-dist_dkr)
npm run cy:open                     # interactive Cypress, for writing specs
scripts/cypress-slot.sh cypress/e2e/uat-claims.cy.js   # one spec, one browser at a time machine-wide
```

- `setup-demo-db.sh` replays the init scripts of the published `openimis-pgsql` image
  (schema + `demo_db.sql`) into a new database of the dev Postgres container, runs the
  Django migrations and gives `Admin` the Django superuser flag (needed for `/api/admin`,
  which the suite uses; core no longer derives it from the legacy IsSystem role).
  `--empty` skips `demo_db.sql` and defaults the database name to `empty_imis`. Point
  `start-uat-stack.sh` at it with `UAT_DB_NAME=empty_imis` when proving the suite does
  not need the demo rows.
- `start-uat-stack.sh` starts `manage.py runserver` with `backend/.env` plus the database
  override, and the frontend from `vite.uat.config.mjs` (the assembly's `vite.config.js`
  with another port, `/api` target and Vite cache directory). By default it builds the
  frontend (~2 min, into `dist/`) and serves it with `vite preview`, like a deployed
  instance: a page loads in about 1 s, against 10–20 s from the dev server, whose
  ~500 module requests per reload get close to Cypress's 15 s command timeout.
  `UAT_FRONTEND_MODE=dev` serves the sources instead, to try module edits without a
  rebuild. Logs go to `logs/`.
- The target must serve the frontend under `/front/` and the backend under `/api/`, with
  `Admin` / `admin123` (`cypress/fixtures/cred.json`). Demo rows are optional.
- Browser cookies ignore ports: while both stacks are open in one browser, they share the
  login cookie (Cypress uses its own browser profile, so runs are not affected).

Each run writes `reports/<timestamp>/` (and `reports/latest`):

| File | Content |
|------|---------|
| `report.html` | one row per UAT case: passed / failed / not automated / out of scope, duration, the Cypress tests behind it, errors |
| `junit.xml` | every Cypress test, for CI |
| `testlink-results.xml` | results to import into TestLink (execution_duration in minutes) |
| `uat-results.json` | raw data; `npm run uat:report` re-renders the report from it (e.g. after a catalog change) |
| `module-config-before.json` | module configurations as they were before the run |
| `task-sources-before.json` | task group bindings as they were before the run |

The exit code is non-zero when any Cypress test fails.

With `--parallel N`, specs that change state every spec depends on (module configuration
through Django admin, login lockouts: those calling `setModuleConfig`, `deleteModuleConfig`,
`loginAdminInterface` or `resetLoginFailures`) still run one at a time, first. The others
then run N at a time against the pinned configuration, applied once by the runner; their
output goes to `reports/<timestamp>/logs/` only. Each spec gets its own browser, so N=3
needs a few GB of memory. A spec still running after `--spec-timeout` minutes (45) is
killed and reported as failed.

When several people or agents write specs at once, run them through
`scripts/cypress-slot.sh`: it holds a lock so only one Cypress browser runs at a time
(each takes 1-2 GB), keeps earlier screenshots, and does not re-pin the module
configuration (pin it once with `node scripts/module-config.mjs pin`).

## Mapping Cypress tests to UAT cases

A Cypress test covers a UAT case when its title contains `OCM-<id>`, e.g.
`it('Rejects incorrect password (OCM-1124)', …)`. A test may cover several cases; a case
passes only if every test covering it passed. Untagged tests are listed separately.

## The UAT catalog

`uat/catalog.json` holds every case of the TestLink export with a review verdict:

| Verdict | Meaning |
|---------|---------|
| `KEEP` | valid as written |
| `UPDATE` | feature exists, steps rewritten for the current UI (`proposed_steps`) |
| `DUPLICATE` | same as `duplicate_of` |
| `NOT_INSTALLED` | the module exists upstream but is not in this assembly |
| `OBSOLETE` | feature removed |

plus automation hints (route, labels, prerequisites, re-run strategy). To validate it:

```bash
node scripts/build-review.mjs          # writes uat/review.html; open it in a browser
# decide per case, then "Export decisions.json" into uat/
node scripts/apply-decisions.mjs uat/decisions.json
```

## Predictable environment

- **Module configuration** — before every spec file, `uat/module-config.pinned.json` is
  applied through Django admin: approval (maker-checker) flags explicitly on, and the
  `fe-core` menu of the release server (`uat/module-config/fe-core.release.json`, from
  `https://release.openimis.org/api/graphql` → `moduleConfigurations`; refresh it the same
  way when the release menu changes). Workflow specs open pages by URL
  (`cypress/support/routes.js`), so they do not depend on the menu layout. A spec needing other values sets them in its own `before()`.
  The runner backs up the configurations first and restores them at the end
  (`--keep-config` to skip). Only `individual`, `social_protection` and
  `grievance_social_protection` hot-reload their configuration; the backend must run as a
  single process (e.g. `runserver`) for the reload to reach every request.
  `CYPRESS_PIN_MODULE_CONFIG=false` disables the pinning.
- **Login lockout** — django-axes locks an IP after `LOGIN_LOCKOUT_FAILURE_LIMIT` failed
  logins, and the whole suite shares one IP. Failed attempts are cleared before every spec
  and after the failed-login tests (`node scripts/module-config.mjs reset-lockout` by hand).
  On a dedicated UAT backend, raising the limit or `AXES_ENABLED=false` is simpler.
- **Async mutations** — a mutation response only means the MutationLog row exists.
  `support/mutations.js` records the `clientMutationId` of every mutation the app sends;
  `cy.waitForJournalProgress()` / `cy.waitForSentMutations()` poll `mutationLogs` until the
  ones sent since the last wait are processed, instead of racing the journal spinner.
- **Rate limit** — GraphQL is limited per IP (`RATELIMIT_RATE`) in `MODE=PROD` only.
- **Data** — before every spec file, `support/e2e.js` runs the `ensureBaseline` task
  (`scripts/baseline.mjs`). Each record is looked up by its code and created only when
  missing, so a later run only reads. Specs take codes, names, ids and uuids from
  `baseline()` in `cypress/support/baseline.js`, inside a hook or a test. The location
  tree is fixed (`r1` with districts `r1d1` and `r1d2`, region `r2` on its own); a test
  that needs records in the same district and a test that needs a record the user must
  not see pick different aliases from that tree. The runner also calls `ensureBaseline`
  once before the specs (`scripts/run-uat.mjs`). Anything only one spec needs is seeded
  by that spec, on baseline records, with a code unique to the run.
  The baseline also owns the task group bindings, because a new task arrives ACCEPTED in
  the group bound to its source and RECEIVED without a group otherwise, and specs test
  both: `any` binds nothing, `pc-cycles` binds `PaymentCycleService`, and every other
  group loses its sources (e.g. `TG1` on release.openimis.org). The runner restores the
  server's bindings at the end (`--keep-config` to skip); after a single-spec run, use
  `node scripts/baseline.mjs --restore-task-sources <file>` with a backup. The demo dataset
  still has no social-protection, policy-holder, contract or invoice data, and its own
  policies expired in 2020–2021; those flows do not use it.

## Claim checks (OCM-53..77, 98)

`cypress/e2e/claim-checks.cy.js` covers the claim rejections at submission: family or
policy missing, patient category, waiting period, maximum provisions, category maxima
(consultations, surgeries, deliveries, antenatal, admissions, visits), items/services not
covered, care type and frequency. The data they need (an active policy, a product with
low limits, earlier claims using a limit up) does not exist in the demo dataset and takes
a long time to set up by hand; `scripts/claim-seed.mjs` creates it through the API, with
a separate family, policy, items and services per case. Each case then submits its claim
from Health Facility Claims and checks the rows (Status, R) on the claim page; the
claim-level reason is not shown in the UI and is checked through the API.

```bash
node scripts/claim-seed.mjs                  # backend only: every case, result per case
node scripts/claim-seed.mjs OCM-61 OCM-63
CYPRESS_CLAIM_CASES=OCM-61 node scripts/run-uat.mjs --spec cypress/e2e/claim-checks.cy.js
```

Care dates are tomorrow: the price-list lookup used for deductions does not find a
price-list row created the same day as the care, and a policy is read as recorded on the
care date (OP-3234), so care must not be dated before today. See `CARE_DAY` in
`claim-seed.mjs`.

## Shared helpers worth knowing

| Command | Use |
|---------|-----|
| `cy.chooseMuiSelect(label, value)` | MUI Select (`role=combobox`) or Autocomplete (types the value) |
| `cy.chooseMuiDatePicker(label, {day, month, year})` | MUI X v8 popper or legacy picker; jumps to the year |
| `cy.clickRowAction(rowText, label)` | row action in a fe-core `ActionMenu` ("…") or an inline button |
| `cy.waitForSearcherLoaded()` | results title shows a count and no longer "Loading..." |
| `cy.waitForMutationLog(id)` | poll one mutation until processed |
| `cy.seedComplexService({...})` | GraphQL seeding for data the demo dataset lacks |

Selectors: MUI 7 tooltips label their child with `aria-label` (v4: `title`), so
`:is([title="X"],[aria-label="X"])` matches both; label lookups are case-insensitive.

## Known gaps

- Most specs still use pre-Vite/MUI 7 selectors in places (upstream PR #110 started that
  migration); `[title=…]` selectors were converted to also match `aria-label`.
- The timesheet calculation rule is not installed in the dev-tools assembly, so the
  timesheet cases of `payment-plan.cy.js` / `payroll*.cy.js` fail there.
