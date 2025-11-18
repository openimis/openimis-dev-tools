from config import  RELEASE_NAME
from utils import *


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
    print_be_table(modules)
    print_be_git_table(modules)
    print_be_pip_table(modules)
    print_be_solution_builder(modules)
    



def print_fe_config(modules):
    print_fe_table(modules)
    print_fe_git_table(modules)
    print_fe_npm_table(modules)
    print_fe_solution_builder(modules)
    
    



if __name__ == '__main__':
    main()
