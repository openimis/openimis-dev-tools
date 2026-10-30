"""Report which fork branches can be synced from upstream, and which conflict.

This is the read-only companion to gh-sync-fork.py: it never writes to GitHub.
For every repo it compares <fork-org>:<branch> against <upstream-org>:<branch>
and classifies it:

    up-to-date    nothing new upstream
    fast-forward  fork has no local commits -> "Sync fork" just fast-forwards
    clean-merge   fork diverged, but upstream merges without conflict
    conflict      fork diverged and the merge conflicts -> needs a PR
    diverged      fork diverged, conflict check skipped/unavailable

The conflict verdict is computed locally with `git merge-tree` (git >= 2.38)
in a throwaway bare repo, so it is the real merge result rather than a guess.
Pass --no-conflict-check to stay purely on the API (diverged repos are then
reported as `diverged`).

Usage (from the repo root):

    python python/gh-fork-sync-report.py
    python python/gh-fork-sync-report.py --branch develop --out sync-report.md
    python python/gh-fork-sync-report.py --no-conflict-check --limit 5
    python python/gh-fork-sync-report.py --json sync-report.json

Requires a GITHUB_TOKEN with read access to the fork org.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

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

# Order used for the report sections / summary: worst news first.
STATUS_ORDER = (
    'conflict',
    'clean-merge',
    'diverged',
    'fast-forward',
    'up-to-date',
    'no-fork-branch',
    'no-upstream-branch',
    'wrong-parent',
    'not-a-fork',
    'no-fork',
    'compare-error',
    'check-error',
)

STATUS_LABEL = {
    'conflict': 'Conflicts - needs a PR',
    'clean-merge': 'Diverged, merges cleanly',
    'diverged': 'Diverged, conflict not checked',
    'fast-forward': 'Fast-forward available',
    'up-to-date': 'Already up to date',
    'no-fork-branch': 'Branch missing on fork',
    'no-upstream-branch': 'Branch missing upstream',
    'wrong-parent': 'Fork parent is not upstream',
    'not-a-fork': 'Not a GitHub fork',
    'no-fork': 'Fork not found',
    'compare-error': 'Compare failed',
    'check-error': 'Conflict check failed',
}


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


def clone_url(org, repo_name):
    """HTTPS url carrying the token so private forks are reachable too."""
    if GITHUB_TOKEN:
        return f'https://x-access-token:{GITHUB_TOKEN}@github.com/{org}/{repo_name}.git'
    return f'https://github.com/{org}/{repo_name}.git'


def run_git(args, cwd=None):
    return subprocess.run(
        ['git'] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'},
    )


def merge_conflicts(repo_name, upstream_org, fork_org, branch, workdir):
    """Merge upstream:branch into fork:branch locally, without a worktree.

    Returns (conflicted_files, error). A None list with no error means the
    merge is clean; an error string means the check could not be performed.
    """
    path = os.path.join(workdir, repo_name)
    os.makedirs(path, exist_ok=True)
    steps = [
        ['init', '--bare', '-q', path],
        ['-C', path, 'fetch', '-q', '--filter=blob:none', '--no-tags',
         clone_url(fork_org, repo_name), f'{branch}:refs/heads/fork'],
        ['-C', path, 'fetch', '-q', '--filter=blob:none', '--no-tags',
         clone_url(upstream_org, repo_name), f'{branch}:refs/heads/upstream'],
    ]
    for step in steps:
        proc = run_git(step)
        if proc.returncode != 0:
            # Never leak the tokenised url into the report.
            detail = proc.stderr.strip().replace(GITHUB_TOKEN or '\0', '***')
            return None, detail.splitlines()[-1] if detail else 'git failed'

    proc = run_git(['-C', path, 'merge-tree', '--write-tree', '--name-only',
                    'refs/heads/fork', 'refs/heads/upstream'])
    if proc.returncode == 0:
        return [], None
    if proc.returncode == 1:
        # stdout is: <tree oid>\n<conflicted path>\n... then an info section.
        lines = proc.stdout.split('\n')
        files = []
        for line in lines[1:]:
            if not line.strip():
                break
            files.append(line.strip())
        return files, None
    detail = proc.stderr.strip().replace(GITHUB_TOKEN or '\0', '***')
    return None, detail.splitlines()[-1] if detail else 'merge-tree failed'


def inspect_one(g, repo_name, upstream_org, fork_org, branch,
                check_conflicts=True, workdir=None):
    entry = {
        'repo': repo_name,
        'status': None,
        'ahead': 0,
        'behind': 0,
        'files': [],
        'note': '',
    }
    upstream_full = f'{upstream_org}/{repo_name}'
    fork_full = f'{fork_org}/{repo_name}'
    print(f'{fork_full} <- {upstream_full}:{branch}')

    fork_repo = get_repo_or_none(g, fork_full)
    if fork_repo is None:
        entry['status'] = 'no-fork'
        print('  fork not found')
        return entry

    parent = fork_repo.parent
    if parent is None:
        entry['status'] = 'not-a-fork'
        print('  not a GitHub fork')
        return entry
    if parent.full_name.lower() != upstream_full.lower():
        entry['status'] = 'wrong-parent'
        entry['note'] = f'parent is {parent.full_name}'
        print(f'  parent is {parent.full_name}')
        return entry

    if not has_branch(fork_repo, branch):
        entry['status'] = 'no-fork-branch'
        print(f'  branch {branch} missing on fork')
        return entry

    try:
        comparison = fork_repo.compare(branch, f'{upstream_org}:{branch}')
    except GithubException as exc:
        entry['status'] = 'compare-error'
        entry['note'] = format_github_error(exc)
        print(f'  compare failed: {entry["note"]}')
        return entry

    entry['ahead'] = comparison.ahead_by
    entry['behind'] = comparison.behind_by

    if not comparison.ahead_by:
        entry['status'] = 'up-to-date'
        print('  up to date')
        return entry

    if not comparison.behind_by:
        entry['status'] = 'fast-forward'
        print(f'  fast-forward, {comparison.ahead_by} commit(s) behind upstream')
        return entry

    print(f'  diverged: {comparison.ahead_by} upstream / '
          f'{comparison.behind_by} local commit(s)')
    if not check_conflicts:
        entry['status'] = 'diverged'
        return entry

    files, error = merge_conflicts(repo_name, upstream_org, fork_org, branch, workdir)
    if error is not None:
        entry['status'] = 'check-error'
        entry['note'] = error
        print(f'  conflict check failed: {error}')
        return entry
    if files:
        entry['status'] = 'conflict'
        entry['files'] = files
        print(f'  CONFLICT in {len(files)} file(s)')
        for name in files[:10]:
            print(f'    {name}')
        if len(files) > 10:
            print(f'    ... and {len(files) - 10} more')
        return entry

    entry['status'] = 'clean-merge'
    print('  merges cleanly')
    return entry


def render_markdown(entries, upstream_org, fork_org, branch, checked):
    lines = [
        f'# Fork sync report - `{branch}`',
        '',
        f'`{upstream_org}:{branch}` -> `{fork_org}:{branch}` over '
        f'{len(entries)} repository(ies).',
        '',
    ]
    by_status = {}
    for entry in entries:
        by_status.setdefault(entry['status'], []).append(entry)

    lines.append('| Status | Repos |')
    lines.append('| --- | --- |')
    for status in STATUS_ORDER:
        group = by_status.get(status)
        if group:
            lines.append(f'| {STATUS_LABEL.get(status, status)} | {len(group)} |')
    lines.append('')

    conflicts = by_status.get('conflict', [])
    if conflicts:
        lines.append('## Conflicts')
        lines.append('')
        lines.append('These forks have diverged and the upstream merge conflicts. '
                     'GitHub\'s "Sync fork" will refuse them - open a PR instead '
                     '(`python/gh-pr-upstream-to-fork.py`) and resolve by hand.')
        lines.append('')
        for entry in conflicts:
            lines.append(
                f'### `{entry["repo"]}`  '
                f'({entry["ahead"]} upstream / {entry["behind"]} local commits)'
            )
            lines.append('')
            for name in entry['files']:
                lines.append(f'- `{name}`')
            lines.append('')

    for status in STATUS_ORDER:
        if status == 'conflict':
            continue
        group = by_status.get(status)
        if not group:
            continue
        lines.append(f'## {STATUS_LABEL.get(status, status)}')
        lines.append('')
        for entry in group:
            detail = []
            if entry['ahead'] or entry['behind']:
                detail.append(f'{entry["ahead"]} upstream / {entry["behind"]} local')
            if entry['note']:
                detail.append(entry['note'])
            suffix = f' - {"; ".join(detail)}' if detail else ''
            lines.append(f'- `{entry["repo"]}`{suffix}')
        lines.append('')

    if not checked:
        lines.append('_Conflict check disabled (`--no-conflict-check`): diverged '
                     'repos were not merge-tested._')
        lines.append('')
    return '\n'.join(lines)


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description='Report fork/upstream sync state and merge conflicts.',
    )
    parser.add_argument('--branch', default=BRANCH,
                        help=f'Branch to compare on both sides (default: {BRANCH})')
    parser.add_argument('--fork-org', default=FORK_ORG,
                        help=f'Org/user that owns the forks (default: {FORK_ORG})')
    parser.add_argument('--upstream-org', default=UPSTREAM_ORG,
                        help=f'Org that owns upstream (default: {UPSTREAM_ORG})')
    parser.add_argument('--no-conflict-check', action='store_true',
                        help='Skip the local git merge test for diverged repos')
    parser.add_argument('--no-assemblies', action='store_true',
                        help='Do not include assembly / dev-tools repos')
    parser.add_argument('--limit', type=int, default=0,
                        help='Process at most N repos (0 = all)')
    parser.add_argument('--repos', default='',
                        help='Comma-separated name fragments to include')
    parser.add_argument('--out', default='',
                        help='Write the markdown report to this file')
    parser.add_argument('--json', dest='json_out', default='',
                        help='Write the raw results to this JSON file')
    parser.add_argument('--keep-clones', action='store_true',
                        help='Keep the temporary bare repos used for merge tests')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not GITHUB_TOKEN:
        print('GITHUB_TOKEN is not set in config.py / .secrets')
        return 1

    filters = [item.strip() for item in args.repos.split(',') if item.strip()]
    if not filters:
        filters = list(REPOS)

    print(f'Report {args.upstream_org}:{args.branch} -> '
          f'{args.fork_org}:{args.branch}')
    repo_names = collect_repo_names(include_assemblies=not args.no_assemblies)
    repo_names = [name for name in repo_names if matches_repos_filter(name, filters)]
    if args.limit:
        repo_names = repo_names[: args.limit]
    print(f'{len(repo_names)} repository(ies) to inspect\n')

    check_conflicts = not args.no_conflict_check
    workdir = tempfile.mkdtemp(prefix='fork-sync-report-') if check_conflicts else None
    g = github_client()
    entries = []
    try:
        for repo_name in repo_names:
            entries.append(inspect_one(
                g,
                repo_name,
                args.upstream_org,
                args.fork_org,
                args.branch,
                check_conflicts=check_conflicts,
                workdir=workdir,
            ))
    finally:
        if workdir and not args.keep_clones:
            shutil.rmtree(workdir, ignore_errors=True)
        elif workdir:
            print(f'\nclones kept in {workdir}')

    counts = {}
    for entry in entries:
        counts[entry['status']] = counts.get(entry['status'], 0) + 1
    print('\nSummary')
    for status in STATUS_ORDER:
        if status in counts:
            print(f'  {STATUS_LABEL.get(status, status)}: {counts[status]}')

    conflicts = [e for e in entries if e['status'] == 'conflict']
    if conflicts:
        print('\nConflicting repos')
        for entry in conflicts:
            print(f'  {entry["repo"]}: {len(entry["files"])} file(s)')

    markdown = render_markdown(entries, args.upstream_org, args.fork_org,
                               args.branch, check_conflicts)
    if args.out:
        with open(args.out, 'w') as handle:
            handle.write(markdown)
        print(f'\nmarkdown report written to {args.out}')
    if args.json_out:
        with open(args.json_out, 'w') as handle:
            json.dump(entries, handle, indent=2)
        print(f'json report written to {args.json_out}')
    if not args.out and not args.json_out:
        print()
        print(markdown)

    return 1 if any(k.endswith('-error') for k in counts) else 0


if __name__ == '__main__':
    sys.exit(main())
