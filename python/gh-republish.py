from config import  RELEASE_NAME 
from github import Github
from utils import create_pr, parse_npm, parse_pip, create_pr_repo, for_repos, get_repos_name


def main():
    release_name = RELEASE_NAME
    repos_name = get_repos_name(ref_branch=RELEASE_NAME)
    config = for_repos(repos_name,release_name, '', callback)
        
        # check if release exists
def callback(repo,branches,release_name, to_branch):
    print(repo.name)
    tag = repo.get_latest_release().tag_name
    dispatch_inputs = {"logLevel": "Warning", "message": "Log Message"}
    if 'openimis-be' in repo.name:
        # Create the dispatch event
        event_name = 'python-publish.yml'
        try:
            workflow = repo.get_workflow(event_name)
        except:
            event_name = 'publish-python.yml'
    else:
        return
        event_name = 'npmpublish.yml'
        try:
            workflow = repo.get_workflow(event_name)
        except:
            event_name = 'npm-publish.yml'
    try:
        workflow = repo.get_workflow(event_name)
        response = workflow.create_dispatch(tag, dispatch_inputs)
        print(f"{repo.name} publish using {event_name}")
    except Exception as e:
        print(f"Error while creating the {repo.name} publishing using {event_name} action: {e}")
        
        

if __name__ == '__main__':
    main()