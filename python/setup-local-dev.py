from config import GITHUB_TOKEN, USER_NAME, BRANCH
from utils import parse_pip, walk_config_be, walk_config_fe
import os
import json
import git  # pip install GitPython
from github import Github  # pip install pyGithub
import sys
ref_assembly = BRANCH#"develop"
MODE = 'ssh'
if len(sys.argv) > 2:
    MODE = sys.argv[2]
SOLUTION = None


def load_solution_configs(g, solutions, SOLUTION, ref_assembly):
    # Initialize repository
    repo = g.get_repo(solutions)
    
    # Get list of directories at the root of the repository
    contents = repo.get_contents("", ref=ref_assembly)
    
    # Find directory matching SOLUTION (case-insensitive)
    dir_solution = None
    for content in contents:
        if content.type == "dir" and content.name.lower() == SOLUTION.lower():
            dir_solution = content.name
            break
    
    if not dir_solution:
        raise ValueError(f"No directory matching '{SOLUTION}' found in repository {solutions} at ref {ref_assembly}")
    
    # Load be-openimis.json
    try:
        be_content = repo.get_contents(f"{dir_solution}/be-openimis.json", ref=ref_assembly)
        be = json.loads(be_content.decoded_content)
    except Exception as e:
        raise ValueError(f"Failed to load {dir_solution}/be-openimis.json: {str(e)}")
    
    # Load fe-openimis.json
    try:
        fe_content = repo.get_contents(f"{dir_solution}/fe-openimis.json", ref=ref_assembly)
        fe = json.loads(fe_content.decoded_content)
    except Exception as e:
        raise ValueError(f"Failed to load {dir_solution}/fe-openimis.json: {str(e)}")
    
    return be, fe

def main():
    if GITHUB_TOKEN:
        g = Github(GITHUB_TOKEN)
    else: # Anonymous
        g = Github()
    
    
    if SOLUTION:
        solutions = 'openimis/solutions'
        repo = g.get_repo(solutions)
        be, fe = load_solution_configs(g, solutions, SOLUTION, ref_assembly)
    else:
        with open("./backend/openimis.json", "r") as infile:
            be = json.load(infile)
        with open("./frontend/openimis.json", "r") as infile:
            fe = json.load(infile)
   
    be["modules"] = walk_config_be(g, be, clone_repo_be)
    fe["modules"] = walk_config_fe(g, fe, clone_repo_fe)
    # Writing to sample.json
    with open("./backend/openimis-dev.json", "w") as outfile:
        outfile.write(json.dumps(be, indent=4, default=set_default))
    with open("./frontend/openimis-dev.json", "w") as outfile:
        outfile.write(json.dumps(fe, indent=4, default=set_default))    




def get_remote(repo, mode = None):
    if mode == 'ssh':
        remote = repo.ssh_url
    elif GITHUB_TOKEN:
        remote = f"https://{USER_NAME}:{GITHUB_TOKEN}@{repo.git_url[6:]}"
    else:
        remote = f"https://{repo.git_url[6:]}"
    return remote

def clone_repo_be(repo, module_name, ref='develop'):
    details = clone_repo(repo, module_name, ref='develop', root_path="backend-packages")
    return {"name": f"{details['name']}", "pip": f"-e ../{details['rootPath']}/{details['name']}"}

def clone_repo_fe(repo, module_name, ref='develop'):
    details =  clone_repo(repo, module_name, ref='develop', root_path="frontend-packages")
    return {"name": f"{details['name']}", "npm": f"file:../{details['rootPath']}/{details['name']}"}


def clone_repo(repo, module_name, ref='develop', root_path="../"):
    src_path = os.path.abspath(root_path)
    path = os.path.join(src_path, module_name)
    remote = get_remote(repo, MODE)

    if os.path.exists(path):
        repo_git = git.Repo(path)
        try:
            repo_git.remotes.origin.fetch(ref)
            repo_git.git.checkout(ref)
            repo_git.remotes.origin.pull()
            print(f"{module_name} pulled and checked out")
        except Exception as e:
            print(f"error while checking out {module_name} to {ref}:\n{e}")
    else:
        print(f"cloning {module_name}")
        repo_git = git.Repo.clone_from(remote, path)
        repo_git.remotes.origin.fetch(ref)
        repo_git.git.checkout(ref)
    return {"name": f"{module_name}", "path": path, "rootPath": root_path}
    


def set_default(obj):
    if isinstance(obj, set):
        return list(obj)
    raise TypeError


if __name__ == "__main__":
    main()
