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
    print_fe_pip_table(modules)
    print_fe_solution_builder(modules)
    
    


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
