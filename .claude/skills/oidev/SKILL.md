---
name: oidev
description: Turn a reported openIMIS symptom or design idea into a Jira OP ticket (Bug or RFC) targeting the develop branch - investigate the cause in the module repos first, draft and wait for approval, then on request branch from develop, write the failing test, fix, update or create the UAT spec, and open the PR. Use when the user reports something broken or proposes a change for develop, or invokes /oidev. For work that goes into a release branch use /oiri, which builds on this skill.
---

# openIMIS dev ticket

Turn a reported symptom into a ticket that a reviewer can act on without re-doing
the investigation. The value is in the root cause, not in restating the report.

This skill covers the **common** work: an **RFC** or a **bug fix** targeting
**`develop`**. `/oiri` follows it and adds the release aspects (release epic,
`release/*` branch, release reviewer, UAT Deployment). When invoked as `/oidev`,
there is no release epic and no UAT Deployment transition.

## Default behaviour

| | |
|---|---|
| Jira site | `openimis.atlassian.net`, cloudId `1297f455-09a3-4ce2-ad82-51e1486c5d3b` |
| Project | `OP` (openIMIS) |
| Target branch | `develop` — branch from `upstream/develop`, PR against `develop` (`/oiri` overrides) |
| Parent | none; **OP-3181 "Technical debt"** for debt (see 3) (`/oiri` overrides) |
| Reviewer | none by default — **ask** (`/oiri` overrides) |
| Autonomy | Investigate, then **show the draft and wait for approval** before creating anything. Branch and PR only on a separate explicit instruction. |

Below, `<base>` is the target branch: `develop` here, `release/26.10` under `/oiri`.

## 0. Check nobody is already on it

Before investigating, look for work in flight. Two people fixing one symptom is
worse than one, and the second fix usually conflicts with the first.

```bash
# an existing ticket for the same symptom
searchJiraIssuesUsingJql('project = OP AND statusCategory != Done
  AND (summary ~ "<keyword>" OR description ~ "<keyword>") ORDER BY created DESC')

# open PRs touching the suspect repos
gh pr list --repo openimis/<repo> --state open \
  --json number,title,headRefName,updatedAt
```

Also check locally: a module may be sitting on someone's feature branch with
uncommitted work (`git branch --show-current`, `git status`). Branch from
`upstream/<base>` in a **worktree** rather than switching under them.

If an open PR already covers it, say so and stop rather than filing a duplicate.

## 1. Investigate before writing anything

A symptom is a starting point, not the ticket. Find the mechanism.

Code lives in sibling repos, not here: `frontend-packages/<Name>Module/`,
`backend-packages/<module>/`. Each is its own git repo. `frontend/` and
`backend/` are assemblies — see the root `AGENTS.md`.

- Read the actual code path end to end. Do not infer a cause from a symptom.
- Establish **when it broke**: `git log -S'<exact string>'`, `git log --oneline -- <file>`.
  A regression that cancelled out two bugs reads very differently from a new one.
- Check whether other modules share the defect before claiming it is isolated.
  **Reducer case labels use both `case "X":` and `case 'X':`** — a quote-sensitive
  grep silently under-reports and has produced a wrong scope claim before.
- Note which branches carry it: `for b in $(git branch -r ...); do git show $b:<file> ...`

Quote file:line for every claim. If something could not be verified, say so in the
ticket rather than leaving the reader to assume it was.

## 2. Draft, then wait

Show summary, root cause, affected files/branches and proposed issue type. Create
nothing until the user approves.

Issue types in OP: `Bug` · `Epic` · `Story` · `Task` · `Service request` ·
`Meeting` · `Enhancement` · `RFC` · `QAlity Test` · `Sub-task`.

`RFC` ("RequestForChange") is the right type for a design proposal — use it rather
than filing an architecture argument as a Bug.

### What a good description contains

Summary · Steps to reproduce (expected vs actual) · Root cause with file:line and
code · Why it surfaced now, if it is a regression · Proposed fix · **The test that
will capture it**: what it asserts, which defines done (see section 4) · **The UAT
spec that covers it**, existing or to be created (see section 5) · What was **not**
verified. Separate independent defects into numbered root causes; do not merge two
bugs into one narrative.

## 3. Create the ticket

**Create the ticket before using its key.** A key cannot be guessed from the last
one you saw: OP-3181 was assumed for a fix, went to a new epic instead, and the
branch name and commit message of two pushed PRs still carry the wrong key
because renaming a branch closes its PR.

```
createJiraIssue(cloudId, projectKey="OP", issueTypeName=…, summary=…,
                description=…, contentFormat="markdown")
```

Then, as separate calls:

- **Parent**, when there is one — `editJiraIssue(fields={"parent": {"key": …}})`
- **Assignee** — `editJiraIssue(fields={"assignee": {"accountId": …}})`.
  Assignee **cannot** be set during a transition ("not on the appropriate screen");
  it is always its own call.
- **Links** — `createIssueLink(type="Relates", inwardIssue=…, outwardIssue=…)`

### Technical debt

Work with no user-visible symptom, where leaving it costs future time or risk,
goes under **OP-3181 "Technical debt"**.

A bug that *exposes* debt is still a bug: fix the symptom, and raise the debt
separately under OP-3181 so it is not lost in the bug's wake. That is how OP-3182
(payer list) and OP-3183 (the other three hooks-based lists) were split - one had
users hitting it, three did not.

Debt tickets say **what it costs to leave alone**, so they can be prioritised
against feature work rather than accumulating silently. "This is not how we do it
any more" is not on its own a reason to file one.

### Moving the ticket to review

The workflow has no direct Backlog → In Review hop. Walk it, checking
`getTransitionsForJiraIssue` at each step — ids differ per status:

```
Backlog --171--> To Do --261--> In Progress --191--> In Review
```

Only transition to In Review once a PR exists. Under `/oidev` the ticket stops at
In Review.

## 4. Branch and PR — only when asked

Per repo, **never** commit to `<base>` directly:

```bash
git fetch -q upstream <base>
git worktree add -b feature/OP-XXXX <path> upstream/<base>
```

- `upstream` = `openimis/*` (the real repo), `origin` = a personal fork. Push to
  **`upstream`**; PRs target `<base>`.
- Check the branch you are on first. Modules are sometimes left on an unrelated
  feature branch: do the work in a **worktree** from `upstream/<base>` rather
  than switching under it. Never use `git stash` to set work aside, because a
  stray `stash pop` has already applied someone's months-old stash.
- Build every touched module. Run its whole test suite **and a baseline** on
  `upstream/<base>` (a second worktree), so pre-existing failures are not
  reported as yours.

### Test first: the failing test is the definition of done

Before changing any production code:

1. **Write a Vitest test that captures the wrong behaviour.** It asserts the
   *correct* behaviour and must fail, for the reason the ticket describes. Read the
   failure: an import error, a missing mock or wrong test data does not prove the
   bug. Commit it, or at least run it, on the unfixed code.
2. **Fix the code until that test passes, without touching what it asserts.** That
   test is the definition of done. Then run the module's whole suite and the
   correctness lint (`frontend/AGENTS.md`).
3. **Any functional change to that test goes to the user first.** If making it pass
   seems to need a different expectation (the behaviour the ticket asked for turns
   out to be wrong, or another feature such as OP-3179 now requires the opposite),
   stop and ask. Do not edit the assertion and carry on. The same applies when your
   change breaks an *existing* test: say which test, what it asserted, and why you
   think it is now wrong, and wait for an answer.
4. Changes that touch only the harness (data shape, a provider, a mock) need no
   approval, but list them in the PR.
5. If the behaviour cannot be reached from a unit test (a full page against a
   backend, for example), say so in the ticket and the PR, and rely on the UAT
   spec (section 5) or give the manual check. Do not present a lint pass as
   verification.

Name the test in the PR body and the ticket comment, with its result before the fix
(failing) and after (passing).

Running the tests:

- **Make sure the module's tests actually ran.** The assembly's `npm test` only
  discovers modules declared with `@file:` in `openimis.json`/`openimis-dev.json`.
  This dev checkout has neither (modules come in through `vite.config.js`
  aliases), so `npm test` runs only the `assembly` project and **passes having
  tested no module at all**. Use the throwaway config in `frontend/AGENTS.md`
  ("Testing"), pointed at the worktree's `src/`, and run it from `frontend/`:
  `node_modules/.bin/vitest run -c <config> --root .`
- ESLint is required on every frontend PR: install a throwaway ESLint and compare
  the branch against the `<base>` baseline. Never skip it.
- If a module has an open test PR that records the bug as `it.fails`, run that
  test against the fix with `it.fails` changed to `it`. Note in both PRs that
  whichever merges second must make the flip.
- Set assignee and reviewer: `gh pr create --assignee <h>` then
  `gh pr edit <n> --add-reviewer <h>`.
- When PRs span repos, state the **merge order** at the top of each dependent PR
  body — a module PR importing a new fe-core helper fails to resolve on its own.
  Stating it is not enough: **check afterwards that it was honoured.** Module PRs
  have been merged while the fe-core PR they import from was still open, leaving
  the target branch importing a symbol that does not exist. Before reporting a
  set of PRs as merged, re-read each state and verify the shared dependency
  landed first.

Attribution: commits and PR bodies end with the attribution lines given in the
session's system reminder.

## 5. UAT spec: update or create

Every fix or feature is checked against the UAT suite in `uat-test/`. Specs live
in `uat-test/cypress/e2e/`; TestLink cases are tagged `OCM-<n>` in the `it()`
title, e.g. `it('adds a basic product (OCM-315)', …)`.

1. **Find the specs that reach the change.** Grep the OCM id from the ticket
   first, then the page, route or label the change touches:
   `grep -rn "OCM-<n>\|<route>\|<label>" uat-test/cypress/e2e/`.
2. **Fix or behaviour change → update the existing spec.**
   - Remove any workaround the spec carries for the bug.
   - Add an assertion that would catch the bug coming back.
   - **Never loosen an assertion to make a spec pass.** A spec failing because
     the fix is not deployed yet is correct; leave it red until it is.
     Example: OP-3272 (fe-product #124) fixes what OCM-316 and OCM-317 catch;
     both stay red until the fix is deployed.
3. **New feature → create cases.**
   - Add them to the spec for that menu area (`uat-<area>-<page>.cy.js`), or start
     a new spec following its neighbours:
     - baseline data from `cypress/support/baseline.js`;
     - unique codes per run;
     - cleanup in `after()`.
   - Use the OCM id when a TestLink case exists. Otherwise say in the ticket that
     no TestLink case exists yet.
4. **Run it once through `/oiuat`**: the parallel UAT stack, never :3000/:8000.
   Report the result in the PR body and the ticket comment, including "red until
   deployed" when that applies.

Spec changes are made in this repo (`openimis-dev-tools`), not in the module PR.
Mention them in the module PR body.

## 6. Close the loop

Comment on the ticket with the PR link, the merge order, the unit test and UAT
spec results, and **what still needs manual verification**. Then transition to
In Review and set the assignee.

If a claim already on the ticket turns out to be wrong, correct it in a comment
that says plainly what was wrong and why — do not quietly edit the description.

## Traps this project has already sprung

- **A mutation response means *queued*, not done.** `core.async_mutations` is on in
  `PROD`. Code that awaits a mutation then refetches races the Celery worker.
- **Stale backend process.** Python prints source text from disk against the
  *loaded* line number, so an edited file yields a traceback pointing at a line
  that never ran. Check `ps -eo lstart` against the file mtime before concluding a
  fix failed — the dev server runs under `debugpy` with the autoreloader off.
- **Rights selector.** `state.core.user.i_user.rights`. Omitting `user` yields `[]`
  for everyone, silently, with no error.
- **Do not trust a sweep you have not sanity-checked** against a known instance.
- **A green `npm test` may have run no module tests.** See "Running the tests"
  above: only `@file:` modules are discovered.
- **A passing `it.fails` is a failure.** When a fix makes a recorded-broken test
  pass, flip it to `it` in the same PR, or the suite goes red. Two of the four
  failures in fe-core's suite on `release/26.10` were this; fe-core #378 fixed
  all four.
- **A green UAT run after loosening a spec proves nothing.** Only a spec that would
  fail on the bug verifies the fix.
