from config import  RELEASE_NAME
from utils import get_repos_name,for_repos, get_config
import re
import json
import semantic_version # pip install semantic-version

def main():
    release_name = RELEASE_NAME
    repos_name = get_repos_name(ref_branch='develop')
    config = for_repos(repos_name,release_name, release_name, get_config)
    print_fe_config(list(filter(lambda c: c['scope'] == 'fe', config)))
    print_be_config(list(filter(lambda c: c['scope'] == 'be', config)))
        
        # check if release exists
def print_be_config(modules):
    print('be,{1},https://github.com/{0}/releases/tag/{3}, ,{2}'.format('openimis/openimis-be','assembly',RELEASE_NAME,RELEASE_NAME ))
    for module in modules:
        print('be,{1},https://github.com/{0}/releases/tag/{2}, https://pypi.org/project/openimis-be-{1}/{3}/,{2}'.format(module['url'],module['name'],module['version'],module['clean_version'],module['nickname'] ))
    print("BE config")
    for module in modules:
        print(f"""            {{
            "name": "{module['nickname']}",
            "npm": "{module['url']}@{RELEASE_NAME}#egg={module['name']}"
        }},""")
    
   
    
def print_fe_config(modules):   
    print('fe,{1},https://github.com/{0}/releases/tag/{2}, ,{2}'.format('openimis/openimis-fe','assembly',RELEASE_NAME,RELEASE_NAME ))
    for module in modules:
        print('fe,{1},https://github.com/{0}/releases/tag/{2}, https://www.npmjs.com/package/@openimis/fe-{1}/v/{3}/,{2}'.format(module['url'],module['name'],module['version'],module['clean_version'],module['nickname'] ))

    print("FE config")
    for module in modules:
        print(f"""       {{
            "name": "{module['nickname']}",
            "npm": "{module['name']}@{module['url']}#{RELEASE_NAME}"
        }},""")


    
if __name__ == '__main__':
    main()





