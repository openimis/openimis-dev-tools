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
        
    fe = json.loads(repo.get_contents("openimis.json", ref ='develop' ).decoded_content)
    for module in fe['modules']:
        module_name = parse_npm(module['npm'])
        if module_name is not None:
            repo = g.get_repo(module_name)
            tag = repo.get_latest_release().tag_name
            config = {'git':module_name, 'version': tag, 'clean_version' : tag[1:] if tag.startswith('v') else tag }

            if config is not None:
                package_conf = json.loads(repo.get_contents("package.json", ref = 'develop' ).decoded_content)
                config['name'] = package_conf['name']
                if config['name'] == '@openimis/fe':
                    config['nickname']= "CoreModule"
                else:
                    package_conf = repo.get_contents("src/index.js", ref ='develop').decoded_content.decode('utf-8')
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
        if module_name is not None:
            repo = g.get_repo(module_name)
            tag = repo.get_latest_release().tag_name
            config = {'git':module_name, 'version': tag, 'clean_version' : tag[1:] if tag.startswith('v') else tag }


            if config is not None:
                package_conf = repo.get_contents("setup.py", ref =release_name ).decoded_content.decode('utf-8')
                config['name']=re.search(r'name *= *[\'|""](.+)[\'|"]',package_conf ).group(1)
                config['nickname'] =re.search(r'openimis-be-(.+)$',config['name'] ).group(1).replace('-','_')
                be_config.append(config)
    print("fe/be,name,release,packet,version")
    print('be,{1},https://github.com/{0}/releases/tag/{3}, ,{2}'.format(assembly_be,'assembly',RELEASE_NAME,RELEASE_NAME ))

    for module in be_config:
        print('be,{1},https://github.com/{0}/releases/tag/{2}, https://pypi.org/project/openimis-be-{1}/{3}/,{2}'.format(module['git'],module['name'],module['version'],module['clean_version'],module['nickname'] ))
    
    
    
    print('fe,{1},https://github.com/{0}/releases/tag/{2}, ,{2}'.format(assembly_fe,'assembly',RELEASE_NAME,RELEASE_NAME ))
    for module in fe_config:
        print('fe,{1},https://github.com/{0}/releases/tag/{2}, https://www.npmjs.com/package/@openimis/fe-{1}/v/{3}/,{2}'.format(module['git'],module['name'],module['version'],module['clean_version'],module['nickname'] ))


 
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
	


if __name__ == '__main__':
    main()
