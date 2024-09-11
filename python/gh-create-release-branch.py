import re
from time import sleep
from config import GITHUB_TOKEN, RELEASE_NAME, REPOS
from github import Github # pip install pyGithub
from utils import parse_pip, parse_npm, for_repos, get_repos_name, get_config
import json

import semantic_version # pip install semantic-version



    


# (repo,branches, from_branch, to_branch)                
def create_release_branch(repo,branches,source_branch, target_branch):
    sb = repo.get_branch(source_branch)
    branches =repo.get_branches()
    if any(x for x in branches if x.name == target_branch):
        print("branch %s  already exist on repo %s" % (target_branch ,repo.name) )
        return get_config(repo,branches,source_branch, target_branch)
    else:
        print("create branch %s  from %s for repo %s" % (target_branch,source_branch ,repo.name) )
        repo.create_git_ref(ref='refs/heads/' + target_branch, sha=sb.commit.sha)
        return get_config(repo,branches,source_branch, target_branch)

if __name__ == '__main__':
    from_branch = 'develop'
    to_branch = RELEASE_NAME
    repos_name = get_repos_name()
    
    output = for_repos(repos_name, from_branch, to_branch, create_release_branch)
    
    be_config = list(filter(lambda item: item['scope'] == 'be', output))
    fe_config = list(filter(lambda item: item['scope'] == 'fe', output))
    
    print("BE config")
    for module in fe_config:
        print(f"""            {{
            "name": "{module['nickname']}",
            "npm": "{module['url']}@{RELEASE_NAME}#egg={module['name']}"
        }},""")
    
    print("FE config")
    for module in fe_config:
        print(f"""       {{
            "name": "{module['nickname']}",
            "npm": "{module['name']}@{module['url']}#{RELEASE_NAME}"
        }},""")

