from config import  RELEASE_NAME
from utils import get_repos_name,for_repos, get_config
import re
import json
import semantic_version  # pip install semantic-version


def main():
    release_name = RELEASE_NAME
    repos_name = get_repos_name(ref_branch=RELEASE_NAME)
    config = for_repos(repos_name,release_name, release_name, get_config)
    print_fe_config(list(filter(lambda c: c['scope'] == 'fe', config)))
    print_be_config(list(filter(lambda c: c['scope'] == 'be', config)))

    # check if release exists


def print_be_config(modules):
    print("========================= references Be =================================")
    print(f'|=HYPERLINK("https://github.com/openimis/openimis-be_py","Backend Assembly")|=HYPERLINK("https://github.com/openimis/openimis-be_py/releases/tag/{RELEASE_NAME.split("/")[-1]}","{RELEASE_NAME.split("/")[-1]}")|GA| |')

    for module in modules:
        print(f'|=HYPERLINK("{module["url"]}","BE {convert_to_title_case(module["nickname"])}")|=HYPERLINK("{module["url"]}/releases/tag/{module["version"]}","v{module["clean_version"]}")|GA|=HYPERLINK("https://www.pypi.org/project/{module["name"].replace("@openimis/", "").lower()}/{module["clean_version"]}","{module["name"]}")|')
    print("========================= config git ===================================")
    for module in modules:
        print(f"""            {{
            "name": "{module['nickname']}",
            "pip": "{module['git']}@{RELEASE_NAME}#egg={module['name']}"
        }},""")
    print("========================= config pip ===================================")
    for module in modules:
        print("""            {{
            "name": "{}",
            "pip": "{}=={}"
        }},""".format(module['nickname'], module['name'], module['version']))
        



def print_fe_config(modules):
    print("========================= references FE =================================")
    print(f'|=HYPERLINK("https://github.com/openimis/openimis-fe_js","Frontend Assembly")|=HYPERLINK("https://github.com/openimis/openimis-fe_js/releases/tag/{RELEASE_NAME.split("/")[-1]}","{RELEASE_NAME.split("/")[-1]}")|GA| |')

    for module in modules:
        print(f'|=HYPERLINK("{module["url"]}","FE {convert_to_title_case(module["nickname"])}")|=HYPERLINK("{module["url"]}/releases/tag/{module["version"]}","v{module["clean_version"]}")|GA|=HYPERLINK("https://www.npmjs.com/package/@openimis/{module["name"].replace("@openimis/", "").lower()}/v/{module["clean_version"]}","npm:{module["name"]}")|')

    print("========================= config git ===================================")

    print("FE config")
    for module in modules:
        print(f"""       {{
            "name": "{module['nickname']}",
            "npm": "{module['name']}@{module['git']}#{RELEASE_NAME}"
        }},""")

    print("========================= config npn ===================================")
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



if __name__ == '__main__':
    main()
