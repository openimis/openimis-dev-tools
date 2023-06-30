import re
from time import sleep
from config import GITHUB_TOKEN, RELEASE_NAME, REPOS, TIMER
from github import Github # pip install pyGithub
import json

import semantic_version # pip install semantic-version

def main():
    g =Github(GITHUB_TOKEN)
    release_name = RELEASE_NAME
    assembly_fe='openimis/openimis-fe_js'
    assembly_be='openimis/openimis-be_py'
    from_branch = RELEASE_NAME
    #getting the list of modules FE
    repo = g.get_repo(assembly_fe)
    fe_config = []
    fe = json.loads(repo.get_contents("openimis.json", ref ='develop' ).decoded_content)
    for module in fe['modules']:
        module_name = parse_npm(module['npm'])
        #print(module_name)
        if module_name is not None:
            repo = g.get_repo(module_name)
            config = create_release(repo,from_branch)
            package_conf = json.loads(repo.get_contents("package.json", ref ='main' ).decoded_content)
            config['name'] = package_conf['name']
            if config['name'] == '@openimis/fe':
                config['nickname']= "CoreModule"
            else:
                package_conf = repo.get_contents("src/index.js", ref ='main' ).decoded_content.decode('utf-8')
                config['nickname']=re.search(r'export +const +(\w+)Module += +\(cfg\) +=>',package_conf ).group(1)
                if config['nickname'] is None:
                    config['nickname'] = re.search(r'fe-(.+)$',package_conf['name'] ).group(1).capitalize()+"Module"
                else:
                    config['nickname'] = config['nickname']+"Module"
            fe_config.append(config)

        
    
    be_config = []
    repo = g.get_repo(assembly_be)
    be = json.loads(repo.get_contents("openimis.json", ref ='develop' ).decoded_content)
    for module in be['modules']:
        module_name = parse_pip(module['pip'])
        #print(module_name)
        if module_name is not None:
            repo = g.get_repo(module_name)
            config = create_release(repo,from_branch)
            package_conf = repo.get_contents("setup.py", ref ='main' ).decoded_content.decode('utf-8')
            config['name']=re.search(r'name *= *[\'|""](.+)[\'|"]',package_conf ).group(1)
            config['nickname'] =re.search(r'openimis-be-(.+)$',config['name'] ).group(1).replace('-','_')
            be_config.append(config)
    print("BE config")
    for module in be_config:
        print("""            {{
            "name": "{}",
            "pip": "{}=={}"
        }},""".format(module['nickname'],module['name'],module['version'] ))
    
    
    
    print("FE config")
    for module in fe_config:
        print("""            {{
            "name": "{}",
            "npm": "{}@>={}"
        }},""".format(module['nickname'],module['name'],module['version']  ))

 
def parse_pip(pip_str):
    if "https://github.com" in pip_str:
        match =  re.search(r'github.com/(.+).git',pip_str )
        return match.group(1)
    else:
        print("Error name not found")
    
def parse_npm(npm_str):

    match =  re.search(r'@openimis/(.+)@',npm_str )
    return "openimis/openimis-" + match.group(1) + "_js"

                
def create_release(repo,from_branch):
    v=None
    release = list(repo.get_releases())
    head_commit = repo.get_branch(from_branch).commit
    if len(release)>0:
        latest_release_tag = repo.get_latest_release().tag_name
        release_commit = list(filter(lambda x: x.name==latest_release_tag, repo.get_tags()))[0].commit
        diff = repo.compare( head = head_commit.sha, base=release_commit.sha)
        nb_commit = len(diff.commits)
        if latest_release_tag.startswith('v'):
            latest_release_tag =latest_release_tag[1:]
        if len(latest_release_tag)>5:
            latest_release_tag =latest_release_tag[:5]
        if nb_commit > 100:
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
        sleep(TIMER)
    else:
        print("no changes: module {} version: {}".format(repo.name, latest_release_tag))
        return({'version': latest_release_tag })


if __name__ == '__main__':
    main()
