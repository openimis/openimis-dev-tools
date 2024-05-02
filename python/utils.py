import urllib.request
import re
from time import sleep
from config import GITHUB_TOKEN, TIMER
from github import Github, PaginatedList
import json

def create_pr(repo,from_branch,to_branch):
    pulls = repo.get_pulls(state='open', sort='created', head='openimis:'+from_branch, base=to_branch)
    not_merged = True
    
    for pull in pulls.__iter__():
        if not pull.merged: 
            not_merged = False
            #break

    if not_merged:
        title = f"MERGING {from_branch} into {to_branch}"

        diff = repo.compare(head=from_branch, base=to_branch)
        nb_commit = diff.commits.totalCount if isinstance(diff.commits, PaginatedList.PaginatedList) else len(diff.commits)
        
        if  nb_commit:
            page = urllib.request.urlopen(diff.diff_url)
            diff_str = page.read()
            if '@@' in  str(diff_str):
                print("PR created between  {} and  {}  for repo {}".format(from_branch,to_branch, repo.name))
                sleep(TIMER)
                pr = repo.create_pull(title=title, body=title, head=from_branch, base=to_branch)
                return pr.number
            else:
                print("no change despite commit between  {} and  {}  for repo {}".format(from_branch,to_branch, repo.name))
        else:
            print("no commit between  {} and  {}  for repo {}".format(from_branch,to_branch, repo.name))
    else:
            print(" {} Pr already existing between  {} and  {}  for repo {}".format(len(list(pulls)),from_branch,to_branch, repo.name))


def parse_pip(pip_str):
    if "https://github.com" in pip_str:
        match =  re.search(r'github.com/(.+).git',pip_str )
        return match.group(1)
    else:
        print("Error name not found")
    
def parse_npm(npm_str):

    match =  re.search(r'@openimis/(.+)@',npm_str )
    return "openimis/openimis-" + match.group(1) + "_js"

def get_repos_name(ref_branch = 'develop'):
    g =Github(GITHUB_TOKEN)
    repos_name = [] 
    assembly_fe='openimis/openimis-fe_js'
    assembly_be='openimis/openimis-be_py'
    #getting the list of modules FE
    repo = g.get_repo(assembly_fe)

    fe = json.loads(repo.get_contents("openimis.json", ref = ref_branch ).decoded_content)
    for module in fe['modules']:
        module_name = parse_npm(module['npm'])
        if module_name is not None:
            repos_name.append(module_name)
    #getting the list of modules BE
    repo = g.get_repo(assembly_be)

    be = json.loads(repo.get_contents("openimis.json", ref = ref_branch ).decoded_content)
    for module in be['modules']:
        module_name = parse_pip(module['pip'])
        if module_name is not None:
            repos_name.append(module_name)
    return repos_name
            
def  create_pr_repo(repo, branches,from_branch, to_branch):
    if to_branch in branches and from_branch in branches:
        pr_id = create_pr(repo, from_branch, to_branch)


  
def flatten_json(y):
    out = {}

    def flatten(x, name=''):
        if type(x) is dict:
            for a in x:
                flatten(x[a], name + a + '.')
        elif type(x) is list:
            i = 0
            for a in x:
                flatten(a, name + str(i) + '.')
                i += 1
        else:
            out[name[:-1]] = x

    flatten(y)
    return out  
            
def for_repos(repos_name,from_branch, to_branch, callback):
    output = []
    g =Github(GITHUB_TOKEN)
    for repo_name in repos_name:
        repo = g.get_repo(repo_name)
        branches = [x.name for x in list(repo.get_branches())]
        # check if release exists
        
        res = callback(repo,branches, from_branch, to_branch)
        if res:
            output.append(res)
    return output