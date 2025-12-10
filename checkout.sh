#!/bin/sh
# You can place this in a file like pull-openimis.sh

# You will first have to be in the dev tools directory, so don't forget to: 
# cd openimis-dev-tools 
BRANCH_NAME="develop"

prompt_for_branch() {
    read -r -p "Enter the branch name (e.g., develop, release/25.10): " BRANCH_NAME
    if [ -z "$BRANCH_NAME" ]; then
        echo "Branch name not specified, defaulting to 'develop'"
	BRANCH_NAME="develop"
    fi
}

prompt_for_branch

# Pull changes for the backend assembly
(cd backend && git checkout $BRANCH_NAME)

# Pull changes for the frontend assembly
(cd frontend && git checkout $BRANCH_NAME)

# Pull changes for repos in backend-packages
for dir in backend-packages/*; do
  if [ -d "$dir/.git" ]; then
    echo "checkout out $dir to $BRANCH_NAME"
    (cd "$dir" && git checkout $BRANCH_NAME)
  fi
done
# Pull changes for repos in backend-packages
for dir in frontend-packages/*; do
  if [ -d "$dir/.git" ]; then
    echo "checkout out $dir to $BRANCH_NAME"
    (cd "$dir" && git checkout $BRANCH_NAME)
  fi
done
