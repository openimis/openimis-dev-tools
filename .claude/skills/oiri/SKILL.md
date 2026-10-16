---
name: oiri
description: Raise an openIMIS release ticket in the Jira OP project from a reported symptom - investigate the cause in the module repos first, then file it under the current release epic with a reviewer set. Use when the user reports something broken or missing in openIMIS and wants it tracked, or invokes /oiri. Covers the Jira ticket, and the fix branch and PR when asked for them.
---

# openIMIS release ticket

Turn a reported symptom into a ticket that a reviewer can act on without re-doing
the investigation. The value is in the root cause, not in restating the report.

## Default behaviour

| | |
|---|---|
| Jira site | `openimis.atlassian.net`, cloudId `1297f455-09a3-4ce2-ad82-51e1486c5d3b` |
| Project | `OP` (openIMIS) |
| Reviewer | Zikani Nyirenda — Jira `712020:7c23535f-1554-4922-ad8c-a4357eaacffb`, GitHub `zikani03`. **Confirm before applying**; the ticket may belong to someone else. |
| Autonomy | Investigate, then **show the draft and wait for approval** before creating anything. Branch and PR only on a separate explicit instruction. |

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
`upstream/release/26.10` in a **worktree** rather than switching under them.

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
code · Why it surfaced now, if it is a regression · Proposed fix · What was **not**
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

- **Parent** — `editJiraIssue(fields={"parent": {"key": "<release epic, or OP-3181>"}})`
- **Assignee** — `editJiraIssue(fields={"assignee": {"accountId": …}})`.
  Assignee **cannot** be set during a transition ("not on the appropriate screen");
  it is always its own call.
- **Links** — `createIssueLink(type="Relates", inwardIssue=…, outwardIssue=…)`

### Which parent: release, or technical debt

Two parents, and the test is whether a user is affected **today**.

| | Parent |
| --- | --- |
| Anything with a user-visible symptom | the release epic (`YY.MM Modular Release`) |
| No symptom; leaving it costs future time or risk | **OP-3181 "Technical debt"** |

A bug that *exposes* debt is still a bug: fix the symptom under the release, and
raise the debt separately under OP-3181 so it is not lost in the bug's wake. That
is how OP-3182 (payer list) and OP-3183 (the other three hooks-based lists) were
split - one had users hitting it, three did not.

Debt tickets say **what it costs to leave alone**, so they can be prioritised
against feature work rather than accumulating silently. "This is not how we do it
any more" is not on its own a reason to file one.

### Finding the release parent

Release epics are named `YY.MM Modular Release`. Two per year: **04** and **10**.
Discover it, never hardcode:

```
searchJiraIssuesUsingJql(jql='project = OP AND issuetype = Epic
  AND summary ~ "Modular Release" AND statusCategory != Done ORDER BY summary ASC')
```

Pick the earliest not-Done epic at or after the current period. As of October 2026
that is **OP-2851 — "26.10 Modular Release"** (27.04 is OP-3144; 26.04 OP-2792 is
Done). If the expected epic does not exist, ask rather than inventing one.

### Moving the ticket to review

The workflow has no direct Backlog → In Review hop. Walk it, checking
`getTransitionsForJiraIssue` at each step — ids differ per status:

```
Backlog --171--> To Do --261--> In Progress --191--> In Review
```

Only transition to In Review once a PR exists.

## 4. Branch and PR — only when asked

Per repo, **never** commit to `release/*` directly:

```bash
git fetch -q upstream release/26.10
git checkout -B feature/OP-XXXX upstream/release/26.10
```

- `upstream` = `openimis/*` (the real repo), `origin` = a personal fork. Push to
  **`upstream`**; PRs target `release/26.10`.
- Check the branch you are on first. Modules are sometimes left on an unrelated
  feature branch — stash, branch from `upstream/release/26.10`, pop, and confirm
  the other branch is untouched.
- Build every touched module. Run the test suite **and a stashed baseline**, so
  pre-existing failures are not reported as yours. `fe-core` has no `test` script;
  use the app's binary: `frontend/node_modules/.bin/vitest run --root .`
- Set assignee and reviewer: `gh pr create --assignee <h>` then
  `gh pr edit <n> --add-reviewer <h>`.
- When PRs span repos, state the **merge order** at the top of each dependent PR
  body — a module PR importing a new fe-core helper fails to resolve on its own.
  Stating it is not enough: **check afterwards that it was honoured.** Module PRs
  have been merged while the fe-core PR they import from was still open, leaving
  the release branch importing a symbol that does not exist. Before reporting a
  set of PRs as merged, re-read each state and verify the shared dependency
  landed first.

Attribution: commits end with
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`;
PR bodies with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## 5. Close the loop

Statuses in this workflow: merged and waiting to go out is **UAT Deployment**
("deploy for testing"). There is no direct hop from Backlog — walk `171` To Do,
`261` In Progress, `191` In Review, `211` UAT Deployment, re-reading the
available transitions at each step.

**Do not move a ticket to UAT Deployment on "the PR is merged" alone.** Check the
work is usable on the target branch: if it depends on another PR that is still
open, merged means broken, not ready.

Comment on the ticket with the PR link, the merge order, and **what still needs
manual verification**. Then transition to In Review and set the assignee.

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
