#!/bin/sh
# You can place this in a file like pull-openimis.sh

# You will first have to be in the dev tools directory, so don't forget to: 
# cd openimis-dev-tools 
BRANCH_NAME="release/25.10"

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
