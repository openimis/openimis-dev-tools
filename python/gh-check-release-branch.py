from config import  RELEASE_NAME
from utils import get_repos_name,for_repos,parse_filter_args


def main():
    release_name = RELEASE_NAME
    repo_filter = parse_filter_args(f'List the repos that have a {release_name} branch.')
    repos_name = get_repos_name()
    for_repos(repos_name,release_name, '', callback, repo_filter)
        
        # check if release exists

def callback(repo,branches,release_name, to_branch):
    if release_name in branches:
        print(" {} branch existing {}".format(repo.name,release_name))



    
if __name__ == '__main__':
    main()
