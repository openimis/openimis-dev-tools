"""Merge the open RELEASE_NAME -> develop PRs that have no conflict and green checks.

Lint (flake8, ESLint) checks block the merge unless --skip-lint is given; Sonar
checks are always reported but never block the merge.

Run gh-pr-release-to-develop.py first to open the PRs. Without --merge this is a
dry run that only reports what would be merged and why the others are skipped.
"""
import argparse
import re
import time

from config import GITHUB_TOKEN, RELEASE_NAME
from github import Github
from utils import add_filter_argument, filter_repos, get_repos_name

OK_CONCLUSIONS = {'success', 'neutral', 'skipped'}
# Sonar is reported but never blocks the merge
NON_BLOCKING = re.compile(r'sonar', re.IGNORECASE)
# Lint (flake8, ESLint) blocks the merge unless --skip-lint makes it advisory
LINT = re.compile(r'lint|flake8', re.IGNORECASE)
# The backend "Run All Tests" job installs every module of the assembly, so it fails on
# whatever module is broken; --ignore-all-tests leaves the module's own tests as the gate
ALL_TESTS = re.compile(r'Run All Tests', re.IGNORECASE)


def find_pr(repo, from_branch, to_branch):
    for pull in repo.get_pulls(state='open', base=to_branch):
        if pull.head.ref == from_branch and pull.head.repo and pull.head.repo.full_name == repo.full_name:
            return pull
    return None


def wait_mergeable(pull, tries=5):
    # GitHub computes mergeability in the background: None means "not known yet"
    for _ in range(tries):
        if pull.mergeable is not None:
            return pull.mergeable
        time.sleep(3)
        pull.update()
    return None


def checks_state(repo, sha, ignore_all_tests=False, skip_lint=False):
    """Return (ok, reason) for the check runs and commit statuses of sha."""
    def non_blocking(name):
        return (NON_BLOCKING.search(name) or (skip_lint and LINT.search(name))
                or (ignore_all_tests and ALL_TESTS.search(name)))

    commit = repo.get_commit(sha)
    # A re-run adds a new check run with the same name: only the latest one counts
    latest = {}
    for run in commit.get_check_runs():
        if run.name not in latest or run.id > latest[run.name].id:
            latest[run.name] = run
    runs = list(latest.values())
    statuses = commit.get_combined_status().statuses
    if not runs and not statuses:
        return False, 'no checks ran'
    blocking = [r for r in runs if not non_blocking(r.name)]
    advisory = [f"{r.name} ({r.conclusion or r.status})" for r in runs
                if non_blocking(r.name) and r.conclusion not in OK_CONCLUSIONS]
    advisory += [f"{s.context} ({s.state})" for s in statuses
                 if non_blocking(s.context) and s.state != 'success']
    note = f"; ignored: {', '.join(advisory)}" if advisory else ''
    pending = [r.name for r in blocking if r.status != 'completed']
    if pending:
        return False, f"checks still running: {', '.join(pending)}"
    failed = [f"{r.name} ({r.conclusion})" for r in blocking if r.conclusion not in OK_CONCLUSIONS]
    failed += [f"{s.context} ({s.state})" for s in statuses
               if not non_blocking(s.context) and s.state != 'success']
    if failed:
        return False, f"checks failed: {', '.join(failed)}{note}"
    return True, f"{len(blocking)} blocking checks green{note}"


def process(repo, from_branch, to_branch, merge, allow_untested, ignore_all_tests=False, skip_lint=False):
    pull = find_pr(repo, from_branch, to_branch)
    if pull is None:
        return 'no-pr', 'no open PR'
    label = f"#{pull.number}"
    if pull.draft:
        return 'skipped', f"{label} is a draft"
    mergeable = wait_mergeable(pull)
    if mergeable is None:
        return 'skipped', f"{label} mergeability still unknown, rerun later"
    if not mergeable or pull.mergeable_state == 'dirty':
        return 'conflict', f"{label} has conflicts"
    ok, reason = checks_state(repo, pull.head.sha, ignore_all_tests, skip_lint)
    if not ok and not (allow_untested and reason == 'no checks ran'):
        return 'skipped', f"{label} {reason}"
    if not merge:
        return 'ready', f"{label} would be merged ({reason})"
    try:
        # A merge commit, not a squash: develop must keep the release history
        result = pull.merge(merge_method='merge', sha=pull.head.sha,
                            commit_title=f"Merge {from_branch} into {to_branch} (#{pull.number})")
    except Exception as e:
        return 'failed', f"{label} merge refused: {getattr(e, 'data', e)}"
    if not result.merged:
        return 'failed', f"{label} merge refused: {result.message}"
    return 'merged', f"{label} merged ({reason})"


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--merge', action='store_true', help='actually merge; default is a dry run')
    parser.add_argument('--allow-untested', action='store_true',
                        help='also merge PRs on repos where no check or status ran')
    parser.add_argument('--ignore-all-tests', action='store_true',
                        help='do not block on the backend "Run All Tests" job; the module tests still gate')
    parser.add_argument('--skip-lint', action='store_true',
                        help='do not block on flake8 and ESLint checks; they are still reported')
    add_filter_argument(parser)
    args = parser.parse_args()

    from_branch = RELEASE_NAME
    to_branch = 'develop'
    g = Github(GITHUB_TOKEN, seconds_between_requests=0.75, seconds_between_writes=2.0)
    repos_name = filter_repos(get_repos_name(RELEASE_NAME), args.filter)

    report = {}
    for repo_name in repos_name:
        outcome, detail = process(g.get_repo(repo_name), from_branch, to_branch, args.merge,
                                  args.allow_untested, args.ignore_all_tests, args.skip_lint)
        report.setdefault(outcome, []).append(repo_name)
        print(f"[{outcome}] {repo_name}: {detail}")

    print('\nSummary' + ('' if args.merge else ' (dry run, pass --merge to merge)'))
    for outcome, repos in sorted(report.items()):
        print(f"  {outcome}: {len(repos)}")
