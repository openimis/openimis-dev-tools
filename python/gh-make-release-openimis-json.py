from config import RELEASE_NAME
from utils import get_repos_name, for_repos
import re
import json
import semantic_version  # pip install semantic-version


def main():
    release_name = RELEASE_NAME
    repos_name = get_repos_name(ref_branch='develop')
    config = for_repos(repos_name, release_name, '', callback)
    print_fe_config(list(filter(lambda c: c['scope'] == 'fe', config)))
    print_be_config(list(filter(lambda c: c['scope'] == 'be', config)))

    # check if release exists


def print_be_config(modules):
    print(f'=HYPERLINK("https://github.com/openimis/openimis-be_py","Backend Assembly")|=HYPERLINK("https://github.com/openimis/openimis-be_py/releases/tag/{RELEASE_NAME.split('/')[-1]}","{
        RELEASE_NAME.split('/')[-1]}")|GA| |')

    for module in modules:
        print(f'=HYPERLINK("https://github.com/{module['git']}","BE {convert_to_title_case(module['nickname'])}")|=HYPERLINK("https://github.com/{module['git']}/releases/tag/{module['version']}","v{
              module['clean_version']}")|GA|=HYPERLINK("https://www.pypi.org/project/{module['name'].replace("@openimis/", "").lower()}/{module['clean_version']}","{module['name']}")|')

    print("BE config")
    for module in modules:
        print("""            {{
            "name": "{}",
            "pip": "{}=={}"
        }},""".format(module['nickname'], module['name'], module['version']))


def print_fe_config(modules):

    print(f'=HYPERLINK("https://github.com/openimis/openimis-fe_js","Frontend Assembly")|=HYPERLINK("https://github.com/openimis/openimis-fe_js/releases/tag/{RELEASE_NAME.split('/')[-1]}","{
        RELEASE_NAME.split('/')[-1]}")|GA| |')

    for module in modules:
        print(f'=HYPERLINK("https://github.com/{module['git']}","FE {convert_to_title_case(module['nickname'])}")|=HYPERLINK("https://github.com/{module['git']}/releases/tag/{module['version']}","v{
              module['clean_version']}")|GA|=HYPERLINK("https://www.npmjs.com/package/@openimis/{module['name'].replace("@openimis/", "").lower()}/v/{module['clean_version']}","npm:{module['name']}")|')

    print("FE config")
    for module in modules:
        print("""            {{
            "name": "{}Module",
            "npm": "{}@>={}"
        }},""".format(module['nickname'], module['name'], module['version']))


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


def callback(repo, branches, release_name, to_branch):
    print(repo.name)
    tag = repo.get_latest_release().tag_name
    if 'openimis-fe' in repo.name:
        config = {'scope': 'fe', 'git': repo.organization.login + '/' + repo.name,
                  'version': tag, 'clean_version': tag[1:] if tag.startswith('v') else tag}
        package_conf = json.loads(repo.get_contents(
            "package.json", ref='develop').decoded_content)
        config['name'] = package_conf['name']
        if config['name'] == '@openimis/fe':
            config['nickname'] = "CoreModule"
        else:
            package_conf = repo.get_contents(
                "src/index.js", ref='develop').decoded_content.decode('utf-8')
            config['nickname'] = re.search(
                r'export +const +(\w+)Module += +\(cfg\) +=>', package_conf).group(1)
            if config['nickname'] is None:
                config['nickname'] = re.search(
                    r'fe-(.+)$', package_conf['name']).group(1).capitalize()+"Module"

    else:
        config = {'scope': 'be', 'git': repo.organization.login + '/' + repo.name,
                  'version': tag, 'clean_version': tag[1:] if tag.startswith('v') else tag}
        package_conf = repo.get_contents(
            "setup.py", ref='develop').decoded_content.decode('utf-8')
        config['name'] = re.search(
            r'name *= *[\'|""](.+)[\'|"]', package_conf).group(1)
        config['nickname'] = re.search(
            r'openimis-be-(.+)$', config['name']).group(1).replace('-', '_')
    return config


if __name__ == '__main__':
    main()
