#!/bin/sh

# You will first have to be in the dev tools directory, so don't forget to: 
# cd openimis-dev-tools 
git pull --all

# Pull changes for the backend assembly
(cd backend && git pull --all)

# Pull changes for the frontend assembly
(cd frontend && git pull --all)

# Pull changes for repos in backend-packages
for dir in backend-packages/*; do
  if [ -d "$dir/.git" ]; then
    echo "Updating $dir..."
    (cd "$dir" && git pull --all)
  fi
done
# Pull changes for repos in backend-packages
for dir in frontend-packages/*; do
  if [ -d "$dir/.git" ]; then
    echo "Updating $dir..."
    (cd "$dir" && git pull --all)
  fi
done
