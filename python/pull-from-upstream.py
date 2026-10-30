"""Pull openimis into local clones (the trees setup-local-dev.py manages).

Walks the workspace git repos (dev-tools root, backend/, frontend/,
backend-packages/*, frontend-packages/*), ensures a remote named
`upstream` points at github.com/openimis/<repo>, fetches it, and
fast-forwards the current branch. Failures are printed immediately and
listed again in the summary.

Usage (from the repo root, or from python/):

    python python/pull-from-upstream.py --dry-run
    python python/pull-from-upstream.py
    python python/pull-from-upstream.py --branch develop --fix
    python python/pull-from-upstream.py --repos core,ClaimModule
"""
import argparse
import os
import re
import sys

import git
from git.exc import GitCommandError, InvalidGitRepositoryError, NoSuchPathError

from config import BRANCH, MODE, REPOS, UPSTREAM_ORG

GITHUB_REPO_RE = re.compile(
    r'github\.com[:/]+(?P<owner>[^/]+)/(?P<name>[^/]+?)(?:\.git)?$',
    re.IGNORECASE,
)

PACKAGE_DIRS = ('backend-packages', 'frontend-packages')
ASSEMBLY_DIRS = ('backend', 'frontend')
SKIP_DIR_NAMES = {
    'node_modules',
    'npm-cache',
    '__pycache__',
    'dist',
    '.git',
}


class RepoError(Exception):
    """A single-repo failure that should be reported, not crash the run."""


def log(kind, label, message):
    print(f'{kind:<6} {label}: {message}', flush=True)


def find_workspace_root(explicit=None):
    if explicit:
        return os.path.abspath(explicit)
    candidates = [
        os.getcwd(),
        os.path.dirname(os.path.abspath(__file__)),
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ]
    for path in candidates:
        if os.path.isdir(os.path.join(path, 'backend-packages')) and os.path.isdir(
            os.path.join(path, 'frontend-packages')
        ):
            return os.path.abspath(path)
    raise SystemExit(
        'Could not find the openimis-dev-tools root (expected backend-packages/ '
        'and frontend-packages/). Pass --root.'
    )


def parse_github_url(url):
    if not url:
        return None, None
    cleaned = url.strip().rstrip('/')
    cleaned = re.sub(r'^git\+', '', cleaned)
    match = GITHUB_REPO_RE.search(cleaned)
    if not match:
        return None, None
    return match.group('owner'), match.group('name')


def is_openimis_url(url, upstream_org):
    owner, _ = parse_github_url(url)
    return bool(owner) and owner.lower() == upstream_org.lower()


def remote_url(mode, owner, repo_name):
    if mode == 'https':
        return f'https://github.com/{owner}/{repo_name}.git'
    return f'git@github.com:{owner}/{repo_name}.git'


def remote_map(repo):
    urls = {}
    for remote in repo.remotes:
        try:
            urls[remote.name] = next(remote.urls)
        except StopIteration:
            continue
    return urls


def infer_repo_name(urls, upstream_org):
    preferred = None
    for url in urls.values():
        owner, name = parse_github_url(url)
        if not name:
            continue
        if owner and owner.lower() == upstream_org.lower():
            return name
        if preferred is None:
            preferred = name
    return preferred


def matches_filter(label, urls, filters):
    if not filters:
        return True
    haystacks = [label.lower()]
    for url in urls.values():
        owner, name = parse_github_url(url)
        if name:
            haystacks.append(name.lower())
        if owner:
            haystacks.append(f'{owner}/{name}'.lower())
    return any(item.lower() in text for item in filters for text in haystacks)


def is_git_worktree(path):
    # Submodules (backend/) store .git as a file, not a directory.
    return os.path.exists(os.path.join(path, '.git'))


def iter_local_repos(root, include_root=True):
    """Yield (label, path) for local git working trees."""
    if include_root and is_git_worktree(root):
        yield os.path.basename(root.rstrip(os.sep)) or root, root
    for name in ASSEMBLY_DIRS:
        path = os.path.join(root, name)
        if is_git_worktree(path):
            yield name, path
    for package_dir in PACKAGE_DIRS:
        parent = os.path.join(root, package_dir)
        if not os.path.isdir(parent):
            continue
        for entry in sorted(os.listdir(parent)):
            if entry in SKIP_DIR_NAMES:
                continue
            path = os.path.join(parent, entry)
            if is_git_worktree(path):
                yield f'{package_dir}/{entry}', path


def open_repo(path):
    try:
        return git.Repo(path)
    except (InvalidGitRepositoryError, NoSuchPathError) as exc:
        raise RepoError(f'not a git repository ({exc})') from exc


def ensure_upstream(repo, label, upstream_org, mode, fix=False, dry_run=False):
    urls = remote_map(repo)
    repo_name = infer_repo_name(urls, upstream_org)
    expected = remote_url(mode, upstream_org, repo_name) if repo_name else None

    if 'upstream' in urls:
        current = urls['upstream']
        if is_openimis_url(current, upstream_org):
            return current, False
        if not fix:
            raise RepoError(
                f'upstream is {current} (not {upstream_org}); '
                f're-run with --fix to point it at {expected or upstream_org}'
            )
        if not repo_name:
            raise RepoError(
                f'upstream is {current} (not {upstream_org}) and the GitHub '
                'repo name could not be inferred'
            )
        if dry_run:
            log('WOULD', label, f'set upstream {current} -> {expected}')
            return expected, True
        repo.remotes.upstream.set_url(expected)
        log('FIX', label, f'upstream {current} -> {expected}')
        return expected, True

    if not repo_name:
        raise RepoError(
            'no upstream remote and cannot infer the GitHub repo name from '
            f'existing remotes ({", ".join(urls) or "none"})'
        )
    if dry_run:
        log('WOULD', label, f'add upstream {expected}')
        return expected, True
    repo.create_remote('upstream', expected)
    log('FIX', label, f'added upstream {expected}')
    return expected, True


def current_branch(repo):
    try:
        return repo.active_branch.name
    except TypeError as exc:
        raise RepoError('detached HEAD; checkout a branch first') from exc


def remote_heads(repo, remote_name):
    heads = set()
    try:
        for ref in repo.remotes[remote_name].refs:
            if ref.remote_head != 'HEAD':
                heads.add(ref.remote_head)
    except IndexError:
        pass
    return heads


def ahead_count(repo, branch, remote_name):
    rev = f'{branch}..{remote_name}/{branch}'
    try:
        return sum(1 for _ in repo.iter_commits(rev))
    except (GitCommandError, ValueError):
        return None


def checkout_branch(repo, branch, remote_name, dry_run=False):
    local_names = {head.name for head in repo.heads}
    if branch in local_names:
        if repo.active_branch.name == branch:
            return
        if dry_run:
            return
        repo.git.checkout(branch)
        return
    if branch in remote_heads(repo, remote_name):
        if dry_run:
            return
        repo.git.checkout('-b', branch, f'{remote_name}/{branch}')
        return
    raise RepoError(f'branch {branch} is missing locally and on {remote_name}')


def fetch_upstream(repo):
    try:
        repo.remotes.upstream.fetch()
    except GitCommandError as exc:
        raise RepoError(f'git fetch upstream failed: {exc}') from exc


def pull_upstream(repo, label, branch, ff_only=True, dry_run=False):
    heads = remote_heads(repo, 'upstream')
    if branch not in heads:
        raise RepoError(f'upstream has no branch {branch}')

    incoming = ahead_count(repo, branch, 'upstream')
    if incoming == 0:
        log('OK', label, f'already up to date with upstream/{branch}')
        return 'synced'
    count_txt = f'{incoming} commit(s)' if incoming is not None else 'new commit(s)'
    if dry_run:
        log('WOULD', label, f'pull {count_txt} from upstream/{branch}')
        return 'would-pull'

    pull_args = ['upstream', branch]
    if ff_only:
        pull_args.insert(0, '--ff-only')
    try:
        repo.git.pull(*pull_args)
    except GitCommandError as exc:
        hint = ''
        err = str(exc)
        if 'Not possible to fast-forward' in err or 'diverged' in err.lower():
            hint = (
                ' (local branch has diverged; merge or rebase manually, '
                'or re-run with --merge)'
            )
        raise RepoError(f'git pull upstream {branch} failed{hint}: {exc}') from exc
    log('OK', label, f'pulled {count_txt} from upstream/{branch}')
    return 'pulled'


def process_repo(
    path,
    label,
    upstream_org,
    mode,
    branch=None,
    fix=False,
    dry_run=False,
    ff_only=True,
):
    repo = open_repo(path)
    if repo.bare:
        raise RepoError('bare repository')

    had_upstream = 'upstream' in remote_map(repo)
    ensure_upstream(
        repo,
        label,
        upstream_org,
        mode,
        fix=fix,
        dry_run=dry_run,
    )
    if repo.is_dirty(untracked_files=False):
        raise RepoError('working tree is dirty; commit, stash, or clean it first')
    if dry_run and not had_upstream:
        target_branch = branch or current_branch(repo)
        log('WOULD', label, f'pull {target_branch} after adding upstream')
        return 'would-fix'

    fetch_upstream(repo)
    target_branch = branch or current_branch(repo)
    if branch:
        checkout_branch(repo, target_branch, 'upstream', dry_run=dry_run)
    return pull_upstream(
        repo,
        label,
        target_branch,
        ff_only=ff_only,
        dry_run=dry_run,
    )


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description=(
            'Ensure local clones have an openimis upstream remote and pull it.'
        ),
    )
    parser.add_argument(
        '--root',
        default=None,
        help='Path to openimis-dev-tools (default: auto-detect)',
    )
    parser.add_argument(
        '--branch',
        default=None,
        help=(
            'Checkout and pull this branch from upstream '
            f'(default: stay on the current branch; config BRANCH={BRANCH})'
        ),
    )
    parser.add_argument(
        '--upstream-org',
        default=UPSTREAM_ORG,
        help=f'Expected upstream GitHub org (default: {UPSTREAM_ORG})',
    )
    parser.add_argument(
        '--mode',
        choices=('ssh', 'https'),
        default=MODE if MODE in ('ssh', 'https') else 'ssh',
        help='URL style used when adding/fixing the upstream remote',
    )
    parser.add_argument(
        '--fix',
        action='store_true',
        help='Add a missing upstream remote, or rewrite one that is not openimis',
    )
    parser.add_argument(
        '--merge',
        action='store_true',
        help='Allow merge commits instead of fast-forward-only pulls',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Inspect remotes and fetch, but do not change remotes or merge',
    )
    parser.add_argument(
        '--no-root',
        action='store_true',
        help='Do not process the openimis-dev-tools root repository',
    )
    parser.add_argument(
        '--repos',
        default='',
        help='Comma-separated name fragments to include (overrides config.REPOS)',
    )
    parser.add_argument(
        '--limit',
        type=int,
        default=0,
        help='Process at most N repos (0 = all)',
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    root = find_workspace_root(args.root)
    filters = [item.strip() for item in args.repos.split(',') if item.strip()]
    if not filters:
        filters = list(REPOS)

    print(
        f'Pulling {args.upstream_org} into local clones under {root}'
        f'{" (dry-run)" if args.dry_run else ""}',
        flush=True,
    )

    found = []
    for label, path in iter_local_repos(root, include_root=not args.no_root):
        try:
            repo = open_repo(path)
            urls = remote_map(repo)
        except RepoError as exc:
            log('FAIL', label, str(exc))
            found.append((label, path, False, str(exc)))
            continue
        if not matches_filter(label, urls, filters):
            continue
        found.append((label, path, True, None))

    if args.limit:
        found = found[: args.limit]
    print(f'{sum(1 for item in found if item[2])} repository(ies) to process', flush=True)

    counts = {}
    failures = []
    for label, path, usable, error in found:
        if not usable:
            counts['fail'] = counts.get('fail', 0) + 1
            failures.append((label, error))
            continue
        try:
            status = process_repo(
                path,
                label,
                args.upstream_org,
                args.mode,
                branch=args.branch,
                fix=args.fix,
                dry_run=args.dry_run,
                ff_only=not args.merge,
            )
        except RepoError as exc:
            log('FAIL', label, str(exc))
            counts['fail'] = counts.get('fail', 0) + 1
            failures.append((label, str(exc)))
            continue
        except GitCommandError as exc:
            message = f'git error: {exc}'
            log('FAIL', label, message)
            counts['fail'] = counts.get('fail', 0) + 1
            failures.append((label, message))
            continue
        counts[status] = counts.get(status, 0) + 1

    print('\nSummary', flush=True)
    for status, count in sorted(counts.items()):
        print(f'  {status}: {count}', flush=True)
    if failures:
        print('\nFailures', flush=True)
        for label, message in failures:
            print(f'  - {label}: {message}', flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
