import urllib.request
import re
import os
from config import GITHUB_TOKEN, TIMER, RELEASE_NAME, REPOS

from github import Github, PaginatedList
import json

# Path style constants for local development setup
PATH_STYLE = 'FULL'  # Options: 'RELATIVE', 'FULL', 'DOCKER'
BASE_PATH = '/mnt/data/Development/openimis-dev-tools'

def get_module_path(name, modules_install_path, imis_json_path):
    """Get module path based on style for local development setup"""
    relative_path = os.path.relpath(modules_install_path, os.path.dirname(imis_json_path))
    if PATH_STYLE == 'RELATIVE':
        return os.path.join(relative_path, name)
    elif PATH_STYLE == 'FULL':
        return os.path.join(BASE_PATH, 'frontend-packages', name)
    elif PATH_STYLE == 'DOCKER':
        return os.path.join('/frontend-packages', name)
    else:
        return os.path.join(modules_install_path, name)



def convert_to_title_case(text):
    words = []
    start_index = 0
    for i in range(1, len(text)):
        if text[i].isupper() or text[i] == '_':
            word = text[start_index:i]
            if word:  # Check if the word is not empty
                words.append(word.capitalize())
            # Skip the underscore
            start_index = i + (1 if text.find('_') > -1 else 0)
    last_word = text[start_index:].capitalize()  # Handle the last word
    if last_word:
        words.append(last_word)
    return ' '.join(words)
 
def create_pr(repo,from_branch,to_branch):
    #pulls = repo.get_pulls(state='open', sort='created', head='openimis:'+from_branch, base=to_branch)
    #if not list(pulls):
    all_pulls = repo.get_pulls(state='open', sort='created', head=from_branch, base=to_branch)
    not_merged = True
    pulls = []
    for pull in all_pulls.__iter__():
        if pull.head.ref == from_branch and pull.base.ref == to_branch:
            pulls.append(pull)
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
                pr = repo.create_pull(title=title, body=title, head=from_branch, base=to_branch, draft=True)
                return pr.number
            else:
                print("no change despite commit between  {} and  {}  for repo {}".format(from_branch,to_branch, repo.name))
        else:
            print("no commit between  {} and  {}  for repo {}".format(from_branch,to_branch, repo.name))
    else:
            print(" {} Pr already existing between  {} and  {}  for repo {}".format(len(list(pulls)),from_branch,to_branch, repo.name))


def parse_pip(pip_str):
    if "https://github.com" in pip_str:
        match =  re.search(r'github.com/([^\.]+).git',pip_str )
        if match:
            return match.group(1)
    else:
        match = re.search(r'openimis-be-([\w\-_]+)[=<>]',pip_str )
        if match:
            return 'openimis/openimis-be-' + match.group(1).replace('-','_')+ '_py'
    print("Error name not found")
    
def parse_npm(npm_str):
    match = re.search(r'@openimis/(?:fe-)?(.+)@',npm_str )
    if match:
        return "openimis/openimis-fe-" + match.group(1) + "_js"
    else:
        match = re.search(r'github.com/(.+).git',npm_str )
        if match:
            return match.group(1)
    
def parse_npm_github(npm_str):
    match = re.search(r'^(?:.+@)?([^#@]+)',npm_str )
    if match:
        match = re.search(r'github.com[:/](.+)',match.group(1) )
        if match:
            return match.group(1)
            
def parse_pip_branch(pip_str):
    match = re.search(r'github.com/.+.git@([\w_\-\/\.]+).*',pip_str )
    if match:
        return match.group(1)
    else:
        print("Error branch not found")
        
def parse_npm_branch(npm_str):
    match = re.search(r'github.com/.+#([\w_\-\/\.]+)',npm_str )
    if match:
        return match.group(1)
    else:
        print("Error branch not found")


def get_repos_name(ref_branch = 'develop'):
    g = Github(
            GITHUB_TOKEN,
            seconds_between_requests=0.75,
            seconds_between_writes=2.0
        )
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

def walk_config_be(g,be, callback):
    res = []
    for module in be['modules']:
        module_name = parse_pip(module['pip'])
        if module_name is not None:
            if REPOS and module['name'] not in REPOS:
                print(f"Using original definition for {module['name']} - not in REPOS list")
                res.append(module)
                continue
            repo = g.get_repo(module_name)
            ref = parse_pip_branch(module['pip'])
            if ref in [b.name for b in list(repo.get_branches())]:
                r = callback(repo, module['name'], ref=ref)
            else:
                r = callback(repo, module['name'])
            if r is not None:
                res.append(r)

    return res
def walk_config_fe(g,fe, callback):
    res = []

    for module in fe['modules']:
        module_name = parse_npm(module['npm'])
        if 'file:' in module['npm']:
            res.append(module)
        elif module_name is not None:
            # Check if REPOS is not empty and module_name is in REPOS
            if REPOS and  module['name'] not in REPOS:
                print(f"Using original definition for {module['name']} - not in REPOS list")
                res.append(module)
                continue

            repo_url = parse_npm_github(module['npm'])
            if repo_url:
                repo = g.get_repo(repo_url)
                ref = parse_npm_branch(module['npm'])
                if ref in [b.name for b in list(repo.get_branches())]:
                    r = callback(repo, module['name'], ref=ref)
                else:
                    r = callback(repo, module['name'])
                if r is not None:
                    res.append(r)

    return res
 
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
    g = Github(
            GITHUB_TOKEN,
            seconds_between_requests=0.75,
            seconds_between_writes=2.0
    )
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
    config['branch'] = target_branch
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
            index = repo.get_contents("src/index.js", ref = source_branch).decoded_content.decode('utf-8')
            config['nickname']=re.search(r'export +const +(\w+Module) += +\(cfg\) +=>',index ).group(1)
            if config['nickname'] is None:
                config['nickname'] = re.search(r'fe-(.+)$',package_conf['name'] ).group(1).capitalize()+"Module"

    else:
        config['scope'] = 'be'
        package_conf = repo.get_contents("setup.py", ref = source_branch ).decoded_content.decode('utf-8')
        config['name']=re.search(r'name *= *[\'|""](.+)[\'|"]',package_conf ).group(1)
        config['nickname'] =re.search(r'openimis-be-(.+)$',config['name'] ).group(1).replace('-','_')
    return config

def print_be_table(modules):
    with open('be_references.txt', 'w') as f:
        f.write(f'|=HYPERLINK("https://github.com/openimis/openimis-be_py","Backend Assembly")|=HYPERLINK("https://github.com/openimis/openimis-be_py/releases/tag/{RELEASE_NAME.split("/")[-1]}","{RELEASE_NAME.split("/")[-1]}")|GA| |' + '\n')

        for module in modules:
            f.write(f'|=HYPERLINK("{module["url"]}","BE {convert_to_title_case(module["nickname"])}")|=HYPERLINK("{module["url"]}/releases/tag/{module["version"]}","v{module["clean_version"]}")|GA|=HYPERLINK("https://www.pypi.org/project/{module["name"].replace("@openimis/", "").lower()}/{module["clean_version"]}","{module["name"]}")|' + '\n')
    
def print_be_git_table(modules):
    with open('openimis-be-git.json', 'w') as f:
        modules_json = []
        for module in modules:
            modules_json.append(f"""{{
            "name": "{module['nickname']}",
            "pip": "git+{module['url']}.git@{RELEASE_NAME}#egg={module['name']}"
        }}""" + '\n')
        f.write(f"""{{"modules": [{",".join(modules_json)}]}}""")
def print_be_pip_table(modules):
    with open('openimis-be-pip.json', 'w') as f:
        modules_json = []
        for module in modules:
            modules_json.append("""{{
            "name": "{}",
            "pip": "{}=={}"
        }}""".format(module['nickname'], module['name'], module['version']) + '\n')
        f.write(f"""{{"be_source_package": [{",".join(modules_json)}]}}""")
def print_be_solution_builder(modules):
    with open('source-be.json', 'w') as f:
        modules_json = []
        for module in modules:
            modules_json.append(""""{0}":{{
            "package": "{1}",
            "git": "{2}",
            "version": "{3}",
            "branch": "{4}"
        }}\n""".format(module['nickname'], module['name'],module["url"], module['version'].replace("v",""), module['branch']))
        f.write(f"""{{"be_source_package": {{{",".join(modules_json)}}}}}""")

def print_fe_table(modules):
    with open('fe_references.txt', 'w') as f:
        f.write(f'|=HYPERLINK("https://github.com/openimis/openimis-fe_js","Frontend Assembly")|=HYPERLINK("https://github.com/openimis/openimis-fe_js/releases/tag/{RELEASE_NAME.split("/")[-1]}","{RELEASE_NAME.split("/")[-1]}")|GA| |' + '\n')
        for module in modules:
            f.write(f'|=HYPERLINK("{module["url"]}","FE {convert_to_title_case(module["nickname"])}")|=HYPERLINK("{module["url"]}/releases/tag/{module["version"]}","v{module["clean_version"]}")|GA|=HYPERLINK("https://www.npmjs.com/package/@openimis/{module["name"].replace("@openimis/", "").lower()}/v/{module["clean_version"]}","npm:{module["name"]}")|' + '\n')
def print_fe_git_table(modules):
    with open('openimis-fe-git.json', 'w') as f:
        modules_json = []
        for module in modules:
            modules_json.append(f"""{{
            "name": "{module['nickname']}",
            "npm": "{module['name']}@{module['git']}#{RELEASE_NAME}"
        }}""" + '\n')
        f.write(f"""{{"modules": [{",".join(modules_json)}]}}""")
        
def print_fe_npm_table(modules):
    with open('openimis-fe-npm.json', 'w') as f:
        modules_json = []
        for module in modules:
            modules_json.append(f"""{{
            "name": "{module['nickname']}",
            "npm": "{module['name']}@>={module['version']}"
        }}""" + '\n')
        f.write(f"""{{"modules": [{",".join(modules_json)}]}}""")
def print_fe_solution_builder(modules , branch):
    with open('source-fe.json', 'w') as f:
  
        modules_json = []
        for module in modules:
            modules_json.append(""""{0}":{{
            "package": "{1}",
            "git": "{2}",
            "version": "{3}",
            "branch": "{4}"
        }}""".format(module['nickname'], module['name'],module["url"], module['version'], module['branch']) + '\n')
        f.write(f"""{{"be_source_package": {{{",".join(modules_json)}}}}}""")
        
def get_release_version(release_name):
    # release/26.04 -> 26.04, anything else is used as-is (e.g. develop)
    match = re.match(r'release/([0-9]{2}\.[0-9]{2})$', release_name)
    return match.group(1) if match else release_name
