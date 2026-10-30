from config import  RELEASE_NAME
from utils import *


import re
import json
import semantic_version  # pip install semantic-version


def main():
    release_name = RELEASE_NAME
    repos_name = get_repos_name(ref_branch=RELEASE_NAME)
    config = for_repos(repos_name,release_name, release_name, get_config)
    print_fe_config(list(filter(lambda c: c['scope'] == 'fe', config)), release_name)
    print_be_config(list(filter(lambda c: c['scope'] == 'be', config)), release_name)

    # check if release exists


def get_release_version(release_name):
    # release/26.04 -> 26.04, anything else is used as-is (e.g. develop)
    match = re.match(r'release/([0-9]{2}\.[0-9]{2})$', release_name)
    return match.group(1) if match else release_name


def print_be_config(modules, release_name):
    print_be_table(modules)
    print_be_git_table(modules)
    print_be_pip_table(modules)
    release_version = get_release_version(release_name)

    modules.append({
        'nickname': "assembly",
        'name': "openimis-be",
        "url": "https://github.com/openimis/openimis-be_py",
        'version': release_version,
        'branch': release_name,
    })

    print_be_solution_builder(modules)



def print_fe_config(modules, release_name):
    print_fe_table(modules)
    print_fe_git_table(modules)
    print_fe_npm_table(modules)
    release_version = get_release_version(release_name)

    modules.append({
        'nickname': "assembly",
        'name': "openimis-fe",
        "url": "https://github.com/openimis/openimis-fe_js",
        'version': release_version,
        'branch': release_name,
    })

    print_fe_solution_builder(modules, release_name)




if __name__ == '__main__':
    main()
