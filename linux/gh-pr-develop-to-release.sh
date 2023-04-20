import re
from time import sleep
from config import GITHUB_TOKEN, RELEASE_NAME, REPOS
from github import Github
import json


def main():
    g =Github(GITHUB_TOKEN)
    repos_name = [] 
    release_name = RELEASE_NAME
    assembly_fe='openimis/openimis-fe_js'
    assembly_be='openimis/openimis-be_py'
    #getting the list of modules FE
    repo = g.get_repo(assembly_fe)

    fe = json.loads(repo.get_contents("openimis.json", ref ='develop' ).decoded_content)
    for module in fe['modules']:
        module_name = parse_npm(module['npm'])
        if module_name is not None:
            repos_name.append(module_name)
    #getting the list of modules BE
    repo = g.get_repo(assembly_be)

    be = json.loads(repo.get_contents("openimis.json", ref ='develop' ).decoded_content)
    for module in be['modules']:
        module_name = parse_pip(module['pip'])
        if module_name is not None:
            repos_name.append(module_name)
    
    
    

    for repo_name in repos_name:
        repo = g.get_repo(repo_name)
        branches = [x.name for x in list(repo.get_branches())]
        # check if release exists
        if release_name in branches:
            pr_id = create_pr(repo,'develop',release_name)

 
def parse_pip(pip_str):
    if "https://github.com" in pip_str:
        match =  re.search(r'github.com/(.+).git',pip_str )
        return match.group(1)
    else:
        print("Error name not found")
    
def parse_npm(npm_str):

    match =  re.search(r'@openimis/(.+)@',npm_str )
    return "openimis/openimis-" + match.group(1) + "_js"

                
def create_pr(repo,from_branch,to_branch):
    pulls = repo.get_pulls(state='open', sort='created', head=from_branch, base=to_branch)
    if len(list(pulls)) == 0:
        body = '''
            MERGING RELEASE branches
            Release {}
        '''.format(RELEASE_NAME)
        diff = repo.compare(head=from_branch, base=to_branch)
        if len(diff.commits) > 0:
            print("PR created between  {} and  {}  for repo {}".format(from_branch,to_branch, repo.name))
            sleep(2)
            pr = repo.create_pull(title="MERGING RELEASE branches", body=body, head=from_branch, base=to_branch)
            return pr.number
        else:
            print("no commit between  {} and  {}  for repo {}".format(from_branch,to_branch, repo.name))
    else:
            print(" {} Pr already existing between  {} and  {}  for repo {}".format(len(list(pulls)),from_branch,to_branch, repo.name))

        
    
if __name__ == '__main__':
    main()
