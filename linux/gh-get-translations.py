import re
from time import sleep
from config import GITHUB_TOKEN, RELEASE_NAME, REPOS
from github import Github # pip install pyGithub
import json


import semantic_version # pip install semantic-version

def main():
    g =Github(GITHUB_TOKEN)
    release_name = RELEASE_NAME
    assembly_fe='openimis/openimis-fe_js'
    assembly_be='openimis/openimis-be_py'
    #getting the list of modules FE
    repo = g.get_repo(assembly_fe)
    fe_config = []
    print("load content")
    fe = json.loads(repo.get_contents("openimis.json", ref ='develop' ).decoded_content)
    for module in fe['modules']:
        module_name = parse_npm(module['npm'])
        if module_name is not None:
            repo = g.get_repo(module_name)
            content = None
            module_nickname = module_name.replace('openimis-','').replace('_js','')
            file_list = repo.get_contents("src", ref = 'develop' )

            if any([x.name == 'translations' for x in file_list]):

                file_list = repo.get_contents("src/translations", ref = 'develop' )
                if any([x.name == 'en.json' for x in file_list]):
                    content = repo.get_contents("src/translations/en.json", ref = 'develop' )
                elif any([x.name == 'ref.json' for x in file_list]):
                    content = repo.get_contents("src/translations/ref.json", ref = 'develop' )
            if content is not None:
                print(module_nickname)  
                trad = json.loads(content.decoded_content)
                f = open(f"./{module_nickname}-en.json", "w")
                f.write(json.dumps(trad, indent=4))
                f.close()
            else:
                print(f"{module_nickname}: No trad Found")  
   	
def parse_pip(pip_str):
    if "https://github.com" in pip_str:
        match =  re.search(r'github.com/(.+).git',pip_str )
        return match.group(1)
    else:
        print("Error name not found")
    
def parse_npm(npm_str):
    if "https://github.com" in npm_str:
        match =  re.search(r'github.com/(.+).git',npm_str )
        return match.group(1)
    else:
        match =  re.search(r'@openimis/(.+)@',npm_str )
        return "openimis/openimis-" + match.group(1) + "_js"

                
def create_release_branch(repo,target_branch,source_branch):
    sb = repo.get_branch(source_branch)
    branches =repo.get_branches()
    if any(x for x in branches if x.name == target_branch):
        print("branch %s  already exist on repo %s" % (target_branch ,repo.name) )
        return None
    else:
        print("create branch %s  from %s for repo %s" % (target_branch,source_branch ,repo.name) )
        repo.create_git_ref(ref='refs/heads/' + target_branch, sha=sb.commit.sha)
        return {}



if __name__ == '__main__':
    main()
