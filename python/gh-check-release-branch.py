import re
from time import sleep
from config import GITHUB_TOKEN, RELEASE_NAME, REPOS,TIMER
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
            print(" {} branch existing {}".format(repo.name,release_name))
        #elif 'develop' in branches:
         #   pr_id = create_pr(repo,'develop','main')
 
def parse_pip(pip_str):
    if "https://github.com" in pip_str:
        match =  re.search(r'github.com/(.+).git',pip_str )
        return match.group(1)
    else:
        print("Error name not found")
    
def parse_npm(npm_str):

    match =  re.search(r'@openimis/(.+)@',npm_str )
    return "openimis/openimis-" + match.group(1) + "_js"

                

    
if __name__ == '__main__':
    main()
