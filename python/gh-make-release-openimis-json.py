from config import  RELEASE_NAME
from utils import get_repos_name,for_repos
import re
import json
import semantic_version # pip install semantic-version

def main():
    release_name = RELEASE_NAME
    repos_name = get_repos_name(ref_branch='develop')
    config = for_repos(repos_name,release_name, '', callback)
    print_fe_config(list(filter(lambda c: c['scope'] == 'fe', config)))
    print_be_config(list(filter(lambda c: c['scope'] == 'be', config)))
        
        # check if release exists
def print_be_config(modules):
    print('be,{1},https://github.com/{0}/releases/tag/{3}, ,{2}'.format('openimis/openimis-be','assembly',RELEASE_NAME,RELEASE_NAME ))
    for module in modules:
        print('be,{1},https://github.com/{0}/releases/tag/{2}, https://pypi.org/project/openimis-be-{1}/{3}/,{2}'.format(module['git'],module['name'],module['version'],module['clean_version'],module['nickname'] ))
    print("BE config")
    for module in modules:
        print("""            {{
            "name": "{}",
            "pip": "{}=={}"
        }},""".format(module['nickname'],module['name'], module['version'] ))
    
def print_fe_config(modules):   
    print('fe,{1},https://github.com/{0}/releases/tag/{2}, ,{2}'.format('openimis/openimis-fe','assembly',RELEASE_NAME,RELEASE_NAME ))
    for module in modules:
        print('fe,{1},https://github.com/{0}/releases/tag/{2}, https://www.npmjs.com/package/@openimis/fe-{1}/v/{3}/,{2}'.format(module['git'],module['name'],module['version'],module['clean_version'],module['nickname'] ))


    
    print("FE config")
    for module in modules:
        print("""            {{
            "name": "{}",
            "npm": "{}@>={}"
        }},""".format(module['nickname'],module['name'], module['version']))


def callback(repo,branches,release_name, to_branch):
    print(repo.name)
    tag = repo.get_latest_release().tag_name
    if 'openimis-fe' in repo.name:
        config = {'scope':'fe', 'git':repo.organization.login + '/'+ repo.name, 'version': tag, 'clean_version' : tag[1:] if tag.startswith('v') else tag }
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
    else:
        config = {'scope':'be', 'git':repo.organization.login + '/'+ repo.name, 'version': tag, 'clean_version' : tag[1:] if tag.startswith('v') else tag } 
        package_conf = repo.get_contents("setup.py", ref = 'develop' ).decoded_content.decode('utf-8')
        config['name']=re.search(r'name *= *[\'|""](.+)[\'|"]',package_conf ).group(1)
        config['nickname'] =re.search(r'openimis-be-(.+)$',config['name'] ).group(1).replace('-','_')
    return config



    
if __name__ == '__main__':
    main()





