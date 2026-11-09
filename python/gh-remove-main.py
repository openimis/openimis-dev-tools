from config import  RELEASE_NAME 
from github import Github
from utils import create_pr, parse_npm, parse_pip, create_pr_repo, for_repos, get_repos_name, parse_filter_args

if __name__ == '__main__':
    repo_filter = parse_filter_args()
    from_branch = 'main'
    to_branch = 'main'
    repos_name = get_repos_name('develop')
    for_repos(repos_name, from_branch, to_branch, create_pr_repo, repo_filter)
