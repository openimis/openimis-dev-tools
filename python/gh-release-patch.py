"""
Create a patch release (x.y.z+1) of every module whose release branch has commits
since its last release.

The last release is the highest semver release whose tag is contained in the
branch: a release made from develop or main, ahead of the branch, is ignored.
The new release is marked "latest" only when it is the highest version of the repo.
A module whose commits only touch .github/ (CI) is not released, unless
--include-ci-only is given: its package would be identical to the last one.

    python gh-release-patch.py --dry-run
    python gh-release-patch.py --filter "be-contract_py"
"""
import argparse

import semantic_version  # pip install semantic-version
from github import GithubException

from config import RELEASE_NAME
from utils import add_filter_argument, for_repos, get_repos_name


def parse_version(tag):
    try:
        return semantic_version.Version(tag[1:] if tag.startswith('v') else tag)
    except ValueError:
        return None


def last_release_on_branch(repo, branch):
    """(release, comparison) for the highest release contained in branch, or (None, None)."""
    releases = []
    for release in repo.get_releases():
        version = parse_version(release.tag_name)
        if version is not None and not release.draft:
            releases.append((version, release))
    releases.sort(key=lambda x: x[0], reverse=True)
    for version, release in releases:
        try:
            diff = repo.compare(base=release.tag_name, head=branch)
        except GithubException as e:
            print(f"  cannot compare {release.tag_name}...{branch}: {e.status}")
            continue
        if diff.status in ('ahead', 'identical'):
            return release, diff
    return None, None


def make_callback(dry_run, include_ci_only):
    def create_patch_release(repo, branches, from_branch, to_branch):
        if from_branch not in branches:
            print(f"{repo.name}: no branch {from_branch}, skipped")
            return None
        release, diff = last_release_on_branch(repo, from_branch)
        if release is None:
            print(f"{repo.name}: no release contained in {from_branch}, skipped (release it by hand)")
            return {'repo': repo.name, 'status': 'no-release'}
        nb_commit = diff.ahead_by
        if nb_commit == 0:
            print(f"{repo.name}: {release.tag_name} is up to date")
            return {'repo': repo.name, 'status': 'unchanged', 'version': release.tag_name}
        if not include_ci_only and all(f.filename.startswith('.github/') for f in diff.files):
            print(f"{repo.name}: {nb_commit} commits since {release.tag_name} only change .github/, skipped")
            return {'repo': repo.name, 'status': 'ci-only', 'version': release.tag_name}

        prefix = 'v' if release.tag_name.startswith('v') else ''
        new_tag = prefix + str(parse_version(release.tag_name).next_patch())
        existing_tags = {t.name for t in repo.get_tags()}
        if new_tag in existing_tags:
            print(f"{repo.name}: {new_tag} already exists ({nb_commit} commits since {release.tag_name}), skipped")
            return {'repo': repo.name, 'status': 'conflict', 'version': new_tag}

        highest = max(filter(None, (parse_version(t) for t in existing_tags)), default=None)
        latest = highest is None or parse_version(new_tag) > highest
        head_sha = repo.get_branch(from_branch).commit.sha
        print(f"{repo.name}: {release.tag_name} -> {new_tag} ({nb_commit} commits, "
              f"{head_sha[:7]}{', latest' if latest else ''})")
        if not dry_run:
            body = f"Release {RELEASE_NAME}"
            repo.create_git_tag_and_release(
                new_tag, body, new_tag, body, head_sha, 'commit',
                make_latest='true' if latest else 'false',
            )
        return {'repo': repo.name, 'status': 'planned' if dry_run else 'released',
                'from': release.tag_name, 'version': new_tag, 'commits': nb_commit}
    return create_patch_release


def main():
    parser = argparse.ArgumentParser(
        description=f'Create a patch release of each module with commits on {RELEASE_NAME} since its last release.')
    add_filter_argument(parser)
    parser.add_argument('--dry-run', action='store_true', help='only print what would be released')
    parser.add_argument('--include-ci-only', action='store_true',
                        help='also release modules whose commits only change .github/')
    args = parser.parse_args()

    repos_name = get_repos_name(ref_branch=RELEASE_NAME)
    results = for_repos(repos_name, RELEASE_NAME, RELEASE_NAME, make_callback(args.dry_run, args.include_ci_only), args.filter)

    print()
    for status in ('planned', 'released', 'unchanged', 'ci-only', 'conflict', 'no-release'):
        names = [r['repo'] for r in results if r['status'] == status]
        if names:
            print(f"{status}: {len(names)}")
            if status in ('conflict', 'no-release'):
                print('  ' + ', '.join(names))


if __name__ == '__main__':
    main()
