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

def get_config(repo, branches, source_branch, target_branch):
    config = {}
    config['git'] = repo.git_url
    config['url'] = repo.html_url
    try:
        config['version'] = repo.get_latest_release().tag_name
    except:
        config['version'] = 'v1.0.0'
    config ['clean_version'] = config['version'][1:] if config['version'].startswith('v') else config['version']
    if 'openimis-fe-' in repo.name :
        config['scope'] = 'fe'
        package_conf = json.loads(repo.get_contents("package.json", ref = source_branch ).decoded_content)
        config['name'] = package_conf['name']
        if config['name'] == '@openimis/fe':
            config['nickname']= "CoreModule"
        else:
            package_conf = repo.get_contents("src/index.js", ref = source_branch).decoded_content.decode('utf-8')
            config['nickname']=re.search(r'export +const +(\w+)Module += +\(cfg\) +=>',package_conf ).group(1)
            if config['nickname'] is None:
                config['nickname'] = re.search(r'fe-(.+)$',package_conf['name'] ).group(1).capitalize()+"Module"
            else:
                config['nickname'] = config['nickname']+"Module"
    else:
        config['scope'] = 'be'
        package_conf = repo.get_contents("setup.py", ref = source_branch ).decoded_content.decode('utf-8')
        config['name']=re.search(r'name *= *[\'|""](.+)[\'|"]',package_conf ).group(1)
        config['nickname'] =re.search(r'openimis-be-(.+)$',config['name'] ).group(1).replace('-','_')
    return config