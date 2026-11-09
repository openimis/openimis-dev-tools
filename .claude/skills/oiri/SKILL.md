---
name: oiri
description: Raise an openIMIS release ticket in the Jira OP project from a reported symptom - follow /oidev (investigate, draft, test first, UAT spec update or creation) and add the release aspects - the current release epic as parent, release/26.10 as branch and PR target, the release reviewer, and the walk to UAT Deployment. Use when the user reports something broken or missing in openIMIS that must go into the release and wants it tracked, or invokes /oiri. Covers the Jira ticket, and the fix branch and PR when asked for them.
---

# openIMIS release ticket

**Follow `.claude/skills/oidev/SKILL.md` end to end**: nobody already on it,
investigation, draft and wait, ticket mechanics, test first, ESLint, merge order,
the UAT spec step, closing the loop and the traps list. Read it first.

This skill only adds the **release aspects**, which override the `/oidev` defaults.

## Release defaults

| | |
|---|---|
| Target branch (`<base>`) | `release/26.10` — branch from `upstream/release/26.10`, PR against `release/26.10`. Never commit to `release/*` directly. |
| Parent | the current release epic (`YY.MM Modular Release`), or **OP-3181** for technical debt |
| Reviewer | Zikani Nyirenda — Jira `712020:7c23535f-1554-4922-ad8c-a4357eaacffb`, GitHub `zikani03`. **Confirm before applying**; the ticket may belong to someone else. |
| Final status | **UAT Deployment** once the work is usable on the release branch (see below) |

## Which parent: release, or technical debt

Two parents, and the test is whether a user is affected **today**.

| | Parent |
| --- | --- |
| Anything with a user-visible symptom | the release epic (`YY.MM Modular Release`) |
| No symptom; leaving it costs future time or risk | **OP-3181 "Technical debt"** (see `/oidev` section 3) |

### Finding the release epic

Release epics are named `YY.MM Modular Release`. Two per year: **04** and **10**.
Discover it, never hardcode:

```
searchJiraIssuesUsingJql(jql='project = OP AND issuetype = Epic
  AND summary ~ "Modular Release" AND statusCategory != Done ORDER BY summary ASC')
```

Pick the earliest not-Done epic at or after the current period. As of October 2026
that is **OP-2851 — "26.10 Modular Release"** (27.04 is OP-3144; 26.04 OP-2792 is
Done). If the expected epic does not exist, ask rather than inventing one.

## Statuses: through to UAT Deployment

Merged and waiting to go out is **UAT Deployment** ("deploy for testing"). There
is no direct hop from Backlog. Walk the transitions, re-reading the available
transitions at each step:

```
Backlog --171--> To Do --261--> In Progress --191--> In Review --211--> UAT Deployment
```

**Do not move a ticket to UAT Deployment on "the PR is merged" alone.** Check the
work is usable on the release branch: if it depends on another PR that is still
open, merged means broken, not ready.

Once deployed, the UAT specs that were red until the fix was deployed (`/oidev`
section 5) should turn green. Rerun them through `/oiuat` and report the result on
the ticket.
