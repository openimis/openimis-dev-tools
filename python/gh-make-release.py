import re
from config import  RELEASE_NAME
from utils import for_repos, get_repos_name
from github import Github, PaginatedList # pip install pyGithub
import json

import semantic_version # pip install semantic-version

def main():
    from_branch = RELEASE_NAME
    to_branch = RELEASE_NAME
    repos_name = get_repos_name(ref_branch=RELEASE_NAME)
    for_repos(repos_name, from_branch, to_branch, create_release) 
    
def create_release(repo,branches, from_branch, to_branch):
    v=None
    release = list(repo.get_releases())
    print(repo.name)
    head_commit = repo.get_branch(from_branch).commit
    if len(release)>0:
        latest_release_tag = repo.get_latest_release().tag_name
        release_commit = list(filter(lambda x: x.name==latest_release_tag, repo.get_tags()))[0].commit
        diff = repo.compare( head = head_commit.sha, base=release_commit.sha)
        nb_commit = diff.commits.totalCount if isinstance(diff.commits, PaginatedList.PaginatedList) else len(diff.commits)
        if latest_release_tag.startswith('v'):
            latest_release_tag =latest_release_tag[1:]
        if len(latest_release_tag)>5:
            latest_release_tag =latest_release_tag[:5]
        if nb_commit > 1:
            v = "v"+str(semantic_version.Version(latest_release_tag).next_minor())
            print("new minor: module {} version {}".format(repo.name, str(v)))
        elif nb_commit > 0:
            v = "v"+str(semantic_version.Version(latest_release_tag).next_patch())             
            print("new patch: module {} created {}".format(repo.name, str(v)))
    else:
        v = '1.0.0'

    if v is not None:
        body = '''
            Release {}
        '''.format(RELEASE_NAME)
        
        repo.create_git_tag_and_release(v, body, v, body, head_commit.sha, 'commit')
        return({ 'version': v })
    else:
        print("no changes: module {} version: {}".format(repo.name, latest_release_tag))
        return({'version': latest_release_tag })


if __name__ == '__main__':
    main()
