"""Sync fork branches with upstream using GitHub's "Sync fork" button.

For each module listed in the upstream assemblies' openimis.json (plus the
assemblies themselves), this calls the same API as the web UI's "Sync fork":

    POST /repos/<fork-org>/<repo>/merge-upstream  {"branch": "<branch>"}

Unlike gh-pr-upstream-to-fork.py this creates no PR: GitHub fast-forwards the
fork branch (or merges upstream into it) directly. It cannot resolve
conflicts -- when the fork has diverged with conflicting changes GitHub
answers 409/422 and the repo is reported as needing a PR instead.

Usage (from the repo root):

    python python/gh-sync-fork.py --dry-run
    python python/gh-sync-fork.py
    python python/gh-sync-fork.py --branch develop --fork-org obenma
    python python/gh-sync-fork.py --limit 3

Requires a GITHUB_TOKEN with write access to the fork org, and the fork must
be a real GitHub fork of the upstream repo.
"""
import argparse
import sys

from github import Auth, Github, GithubException, UnknownObjectException

from config import (
    BRANCH,
    FORK_ORG,
    GITHUB_TOKEN,
    REPOS,
    UPSTREAM_ORG,
)
from utils import get_repos_name

ASSEMBLY_REPOS = (
    'openimis-be_py',
    'openimis-fe_js',
    'openimis-dev-tools',
)


def github_client():
    return Github(
        auth=Auth.Token(GITHUB_TOKEN),
        seconds_between_requests=0.75,
        seconds_between_writes=2.0,
    )


def repo_short_name(full_name):
    return full_name.split('/', 1)[-1]


def collect_repo_names(include_assemblies=True):
    names = []
    seen = set()
    for full_name in get_repos_name():
        name = repo_short_name(full_name)
        if name not in seen:
            seen.add(name)
            names.append(name)
    if include_assemblies:
        for name in ASSEMBLY_REPOS:
            if name not in seen:
                seen.add(name)
                names.append(name)
    return names


def matches_repos_filter(repo_name, filters):
    if not filters:
        return True
    lowered = repo_name.lower()
    return any(item.lower() in lowered for item in filters)


def get_repo_or_none(g, full_name):
    try:
        return g.get_repo(full_name)
    except UnknownObjectException:
        return None
    except GithubException as exc:
        print(f"  error fetching {full_name}: {format_github_error(exc)}")
        return None


def has_branch(repo, branch):
    try:
        repo.get_branch(branch)
        return True
    except GithubException:
        return False


def format_github_error(exc):
    parts = [str(exc.status)]
    message = None
    errors = None
    if getattr(exc, 'data', None):
        if isinstance(exc.data, dict):
            message = exc.data.get('message')
            errors = exc.data.get('errors')
        else:
            message = str(exc.data)
    if message:
        parts.append(message)
    if errors:
        parts.append(str(errors))
    return ' - '.join(parts)


def compare_upstream(fork_repo, upstream_org, branch):
    """Commits on upstream:branch that are not in the fork's branch."""
    return fork_repo.compare(branch, f'{upstream_org}:{branch}')


def sync_one(g, repo_name, upstream_org, fork_org, branch, dry_run=False):
    upstream_full = f'{upstream_org}/{repo_name}'
    fork_full = f'{fork_org}/{repo_name}'
    print(f'{fork_full} <- {upstream_full}:{branch}')

    fork_repo = get_repo_or_none(g, fork_full)
    if fork_repo is None:
        print('  skip: fork not found')
        return 'no-fork'

    parent = fork_repo.parent
    if parent is None:
        print('  skip: repo is not a GitHub fork, nothing to sync from')
        return 'not-a-fork'
    if parent.full_name.lower() != upstream_full.lower():
        print(f'  skip: fork parent is {parent.full_name}, expected {upstream_full}')
        return 'wrong-parent'

    if not has_branch(fork_repo, branch):
        print(f'  skip: branch {branch} missing on fork')
        return 'no-fork-branch'

    try:
        comparison = compare_upstream(fork_repo, upstream_org, branch)
    except GithubException as exc:
        print(f'  skip: compare failed: {format_github_error(exc)}')
        return 'compare-error'

    ahead = comparison.ahead_by
    behind = comparison.behind_by
    if not ahead:
        print('  skip: already up to date with upstream')
        return 'synced'

    diverged = ' (fork has local commits)' if behind else ''
    print(f'  {ahead} upstream commit(s) to pull in{diverged}')
    if dry_run:
        print('  dry-run: would sync fork')
        return 'would-sync'

    try:
        result = fork_repo.merge_upstream(branch)
    except GithubException as exc:
        # 409: merge conflict, 422: branch cannot be synced (diverged/protected)
        if exc.status in (409, 422):
            print(f'  cannot sync: {format_github_error(exc)}')
            print('  hint: open a PR instead (python/gh-pr-upstream-to-fork.py)')
            return 'needs-pr'
        print(f'  error syncing: {format_github_error(exc)}')
        return 'sync-error'

    merge_type = result.merge_type or 'unknown'
    if merge_type == 'none':
        print(f'  nothing merged: {result.message}')
        return 'nothing-merged'
    print(f'  synced ({merge_type}): {result.message}')
    return 'synced-now'


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Sync fork branches with upstream (GitHub's Sync fork API).",
    )
    parser.add_argument(
        '--branch',
        default=BRANCH,
        help=f'Branch to sync on both sides (default: {BRANCH})',
    )
    parser.add_argument(
        '--fork-org',
        default=FORK_ORG,
        help=f'GitHub org/user that owns the forks (default: {FORK_ORG})',
    )
    parser.add_argument(
        '--upstream-org',
        default=UPSTREAM_ORG,
        help=f'GitHub org that owns upstream (default: {UPSTREAM_ORG})',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Compare and report, but do not sync',
    )
    parser.add_argument(
        '--no-assemblies',
        action='store_true',
        help='Do not include assembly / dev-tools repos',
    )
    parser.add_argument(
        '--limit',
        type=int,
        default=0,
        help='Process at most N repos (0 = all)',
    )
    parser.add_argument(
        '--repos',
        default='',
        help='Comma-separated name fragments to include (overrides config.REPOS)',
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not GITHUB_TOKEN:
        print('GITHUB_TOKEN is not set in config.py / .secrets')
        return 1

    filters = [item.strip() for item in args.repos.split(',') if item.strip()]
    if not filters:
        filters = list(REPOS)

    print(
        f'Syncing {args.fork_org}:{args.branch} <- '
        f'{args.upstream_org}:{args.branch}'
        f'{" (dry-run)" if args.dry_run else ""}'
    )
    repo_names = collect_repo_names(include_assemblies=not args.no_assemblies)
    repo_names = [name for name in repo_names if matches_repos_filter(name, filters)]
    if args.limit:
        repo_names = repo_names[: args.limit]
    print(f'{len(repo_names)} repository(ies) to process')

    g = github_client()
    counts = {}
    for repo_name in repo_names:
        status = sync_one(
            g,
            repo_name,
            args.upstream_org,
            args.fork_org,
            args.branch,
            dry_run=args.dry_run,
        )
        counts[status] = counts.get(status, 0) + 1

    print('\nSummary')
    for status, count in sorted(counts.items()):
        print(f'  {status}: {count}')
    return 1 if any(key.endswith('-error') for key in counts) else 0


if __name__ == '__main__':
    sys.exit(main())
