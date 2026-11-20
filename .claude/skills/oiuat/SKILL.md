---
name: oiuat
description: Run the openIMIS UAT Cypress tests in uat-test/ against the parallel UAT stack (demo_imis, backend :8001, frontend :3001) and report pass/fail per spec and OCM case. Use when the user invokes /oiuat, or asks to run, rerun or check UAT specs or a TestLink OCM case. Arguments - a spec name or glob, an OCM id, "all", or "report".
---

# openIMIS UAT run

Run the specs, then report the results. **Token budget matters more than anything
else here**: the user stopped an earlier session because the cost was too high.

## Budget rules (follow strictly)

- **No subagents.** Never spawn agents or workflows for a run, and never write or fix
  specs in parallel. One spec run at a time, in this session.
- **Never read a full Cypress log.** Logs are thousands of lines. Read only the
  summary table and the failing test names (commands below). Look at a screenshot or
  a backend log excerpt only for a failure the user asks about.
- **Run in the background** (`run_in_background: true`) and wait for the completion
  notice. Do not poll, do not `sleep`, do not tail the log while it runs.
- **Report, don't fix.** After a run, report the results and stop. Fix a spec only if
  the user asks, and then only that spec, rerun once, and report again.
- Do not re-read files already read in this session.

## Context

| | |
|---|---|
| Folder | `/mnt/data/Development/openimis-dev-tools/uat-test` (see its README.md) |
| Stack | backend :8001 on DB `demo_imis`, frontend :3001 (production build in `dist/`) |
| User's own stack | :3000 / :8000 - **never touch it** |
| Specs | `cypress/e2e/*.cy.js`; the TestLink cases are tagged `OCM-<n>` in `it()` titles |
| Memory | about 30 GB, mostly used by the user's browser: **one** Cypress browser at a time |

## 1. Check the stack

```bash
ss -ltnp | grep -E ':3001|:8001'
```

If one is missing, tell the user and offer `./scripts/start-uat-stack.sh` (it builds
the frontend, which takes a few minutes). Also offer a restart when the user says the
frontend code changed since the last build (`ls -ld --time-style=+%F_%T dist`).

## 2. Pick the command from the argument

| Argument | Command (from `uat-test/`) |
|---|---|
| one spec, e.g. `uat-tasks` | `./scripts/cypress-slot.sh cypress/e2e/uat-tasks.cy.js > <scratchpad>/oiuat-<name>.log 2>&1` |
| an OCM id, e.g. `OCM-1164` | `grep -ln "OCM-1164\b" cypress/e2e/*.cy.js` to find the spec, run that whole spec as above (there is no per-test filter), and report only that case's line |
| several specs or a glob | `node scripts/run-uat.mjs --spec "cypress/e2e/uat-*.cy.js" > <scratchpad>/oiuat-run.log 2>&1` |
| `all` | `node scripts/run-uat.mjs > <scratchpad>/oiuat-run.log 2>&1` (long: hours) - confirm with the user first |
| `report` | `node scripts/run-uat.mjs --report-only` (no run) |

- `cypress-slot.sh` does not pin the module configuration. Before a single-spec run,
  pin it once: `node scripts/module-config.mjs pin`.
- `run-uat.mjs` pins the configuration itself and restores it at the end; its results
  go to `reports/<timestamp>/`.
- Claim checks can be narrowed: `CYPRESS_CLAIM_CASES=OCM-54,OCM-56`.
- Never use `--parallel` above 1 unless the user asks (memory).

## 3. Read only the results

For a single spec:

```bash
grep -E "Tests:|Passing:|Failing:|^\s+[0-9]+\) " <log> | head -40
```

For a `run-uat.mjs` run, the latest folder is `reports/$(ls -t reports | head -1)`.
Each spec has a `<spec>.result.json` (Cypress module API result). Read only the
totals and the failing titles, never the error stacks:

```bash
for f in reports/<latest>/*.result.json; do
  jq -r '"\(input_filename|split("/")[-1]|sub(".result.json";""))\tpass \(.totalPassed) fail \(.totalFailed) pend \(.totalPending) \((.totalDuration/1000|floor))s"' "$f"
  jq -r '.runs[].tests[] | select(.state=="failed") | "   FAIL \(.title[-1])"' "$f"
done
```

`report.html` and `uat-results.json` in the same folder are the full report;
do not read them into context.

## 4. Report

A short table: spec, passed/failed/pending, duration. Then one line per failing test:
its OCM id, and the first line of the assertion error (`grep -A3 "<n>) " <log>`).
Classify each failure only when it is obvious; otherwise say "not investigated".

Known app defects that make tests fail on purpose (do not "fix" the assertion):
see `uat-claim-check-tickets` in memory and the defect lists in the latest report.

If the user wants the report shared, republish the existing artifact
(https://claude.ai/artifact/SiPzt5EYN9yjR72DQ4Kxhr) only when asked.
