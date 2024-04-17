from config import  RELEASE_NAME
from utils import get_repos_name,for_repos


def main():
    release_name = RELEASE_NAME
    repos_name = get_repos_name()
    for_repos(repos_name,release_name, '', callback)
        
        # check if release exists

def callback(repo,branches,release_name, to_branch):
    if release_name in branches:
        print(" {} branch existing {}".format(repo.name,release_name))



    
if __name__ == '__main__':
    main()
