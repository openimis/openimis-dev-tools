"""Create draft PRs on fork repos (obenma) that merge in upstream (openimis).

For each module listed in the upstream assemblies' openimis.json (plus the
assemblies themselves), this opens a cross-fork PR:

    head:  openimis:<branch>
    base:  <branch>          (on the obenma fork)

Usage (from the repo root):

    python python/gh-pr-upstream-to-fork.py --dry-run
    python python/gh-pr-upstream-to-fork.py
    python python/gh-pr-upstream-to-fork.py --branch develop --fork-org obenma
    python python/gh-pr-upstream-to-fork.py --limit 3 --no-draft

Requires a GITHUB_TOKEN with write access to the fork org. The fork must be
a GitHub fork of the upstream repo (not an independent copy) so GitHub can
resolve `openimis:<branch>` as the PR head.
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


def existing_sync_pr(fork_repo, upstream_org, branch):
    """Return an open PR that already merges upstream:branch into fork:branch."""
    try:
        pulls = fork_repo.get_pulls(state='open', base=branch)
    except GithubException as exc:
        print(f"  error listing PRs: {format_github_error(exc)}")
        return None
    for pull in pulls:
        head_ref = pull.head.ref
        head_owner = None
        if pull.head.repo is not None:
            head_owner = pull.head.repo.owner.login
        elif pull.head.label and ':' in pull.head.label:
            head_owner = pull.head.label.split(':', 1)[0]
        if head_ref == branch and head_owner and head_owner.lower() == upstream_org.lower():
            return pull
    return None


def compare_upstream(fork_repo, upstream_org, branch):
    """Commits on upstream:branch that are not in the fork's branch."""
    return fork_repo.compare(branch, f'{upstream_org}:{branch}')


def create_sync_pr(fork_repo, upstream_org, fork_org, branch, draft=True):
    title = f'Sync {branch} from {upstream_org}'
    body = (
        f'Merge `{upstream_org}:{branch}` into `{fork_org}:{branch}` '
        f'to sync this fork with upstream.\n'
    )
    return fork_repo.create_pull(
        title=title,
        body=body,
        head=f'{upstream_org}:{branch}',
        base=branch,
        draft=draft,
        maintainer_can_modify=False,
    )


def sync_one(g, repo_name, upstream_org, fork_org, branch, dry_run=False, draft=True):
    upstream_full = f'{upstream_org}/{repo_name}'
    fork_full = f'{fork_org}/{repo_name}'
    print(f'{fork_full} <- {upstream_full}:{branch}')

    upstream_repo = get_repo_or_none(g, upstream_full)
    if upstream_repo is None:
        print('  skip: upstream repo not found')
        return 'no-upstream'

    if not has_branch(upstream_repo, branch):
        print(f'  skip: branch {branch} missing on upstream')
        return 'no-upstream-branch'

    fork_repo = get_repo_or_none(g, fork_full)
    if fork_repo is None:
        print('  skip: fork not found')
        return 'no-fork'

    parent = fork_repo.parent
    if parent is not None and parent.full_name.lower() != upstream_full.lower():
        print(f'  skip: fork parent is {parent.full_name}, expected {upstream_full}')
        return 'wrong-parent'
    if parent is None and not fork_repo.fork:
        print('  warn: repo is not marked as a GitHub fork; cross-repo PR may fail')

    if not has_branch(fork_repo, branch):
        print(f'  skip: branch {branch} missing on fork')
        return 'no-fork-branch'

    existing = existing_sync_pr(fork_repo, upstream_org, branch)
    if existing is not None:
        print(f'  skip: PR already open {existing.html_url}')
        return 'existing-pr'

    try:
        comparison = compare_upstream(fork_repo, upstream_org, branch)
    except GithubException as exc:
        print(f'  skip: compare failed: {format_github_error(exc)}')
        return 'compare-error'

    ahead = comparison.ahead_by
    files = list(comparison.files) if comparison.files is not None else []
    if not ahead:
        print('  skip: already up to date with upstream')
        return 'synced'
    if not files:
        print(f'  skip: {ahead} commit(s) but no file changes')
        return 'empty-diff'

    print(f'  {ahead} commit(s), {len(files)} file(s) to merge')
    if dry_run:
        print('  dry-run: would open PR')
        return 'would-create'

    try:
        pr = create_sync_pr(fork_repo, upstream_org, fork_org, branch, draft=draft)
    except GithubException as exc:
        print(f'  error creating PR: {format_github_error(exc)}')
        return 'create-error'

    print(f'  PR created {pr.html_url}')
    return 'created'


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description='Open draft PRs on fork repos to merge in upstream branches.',
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
        help='Compare and report, but do not create PRs',
    )
    parser.add_argument(
        '--no-draft',
        action='store_true',
        help='Create ready-for-review PRs instead of drafts',
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
        f'Syncing {args.upstream_org}:*{args.branch} -> '
        f'{args.fork_org}:{args.branch}'
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
            draft=not args.no_draft,
        )
        counts[status] = counts.get(status, 0) + 1

    print('\nSummary')
    for status, count in sorted(counts.items()):
        print(f'  {status}: {count}')
    return 1 if any(key.endswith('-error') for key in counts) else 0


if __name__ == '__main__':
    sys.exit(main())
