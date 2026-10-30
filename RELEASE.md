# OpenIMIS Release Management Scripts

This document describes the Python scripts used for managing releases in the OpenIMIS project. These scripts automate the release process across multiple repositories.

## Prerequisites

Before using these scripts, ensure you have:

1. **Python 3.x** installed
2. **GitHub Personal Access Token** with `repo` permissions
3. **Required Python packages**:
   ```bash
   pip install PyGithub semantic-version
   ```
4. **Configured `python/config.py`** with your GitHub token and settings

## Configuration

Edit `python/config.py` to set:
- `GITHUB_TOKEN`: Your GitHub personal access token
- `RELEASE_NAME`: The release branch name (e.g., 'release/25.10')
- Other settings as needed

## Release Workflow Overview

The typical release workflow follows these steps:

1. **Create release branches** from develop
2. **Create PRs** from develop to release branches
3. **Test and stabilize** the release branches
4. **Create GitHub releases** with semantic versioning
5. **Create PRs** from release to main
6. **Merge and tag** the final release
7. **Create PRs** from release back to develop

## Scripts

### gh-check-release-branch.py

Checks if a release branch already exists across all repositories.

**Usage:**
```bash
python python/gh-check-release-branch.py
```

**What it does:**
- Scans all OpenIMIS repositories
- Reports which repositories already have the configured release branch
- Helps avoid conflicts when creating new release branches

### gh-create-release-branch.py

Creates release branches from the develop branch across all repositories.

**Usage:**
```bash
python python/gh-create-release-branch.py
```

**What it does:**
- Creates a new branch named `RELEASE_NAME` from `develop` in each repository
- Generates configuration files for backend and frontend assemblies
- Outputs tables showing the created branches and versions

**Output files:**
- `be_references.txt`: Backend module references
- `openimis-be-git.json`: Backend Git configuration
- `openimis-be-pip.json`: Backend pip configuration
- `fe_references.txt`: Frontend module references
- `openimis-fe-git.json`: Frontend Git configuration
- `openimis-fe-npm.json`: Frontend npm configuration

### gh-pr-develop-to-release.py

Creates pull requests from develop branches to release branches.

**Usage:**
```bash
python python/gh-pr-develop-to-release.py
```

**What it does:**
- Creates draft PRs merging develop into the release branch
- Only creates PRs if there are actual changes between branches
- Skips repositories that already have open PRs

### gh-pr-release-to-main.py

Creates pull requests from release branches to main.

**Usage:**
```bash
python python/gh-pr-release-to-main.py
```

**What it does:**
- Creates draft PRs merging the release branch into main
- Used for final release merges
- Only creates PRs if there are changes to merge

### gh-pr-release-to-develop.py

Creates pull requests from release branches back to develop.

**Usage:**
```bash
python python/gh-pr-release-to-develop.py
```

**What it does:**
- Creates draft PRs merging the release branch back into develop
- Used to bring release changes back to development branch
- Helps keep develop up-to-date with release fixes

### gh-make-release.py

Creates GitHub releases with automatic semantic versioning.

**Usage:**
```bash
python python/gh-make-release.py
```

**What it does:**
- Analyzes commits since the last release
- Determines version bumps (major, minor, or patch) based on commit count
- Creates GitHub releases with proper semantic version tags
- Updates version numbers across repositories

**Versioning logic:**
- **Patch version** (1.0.0 → 1.0.1): When there are commits but no significant changes
- **Minor version** (1.0.0 → 1.1.0): When there are multiple commits indicating new features
- **Major version** (1.0.0 → 2.0.0): For breaking changes (manual intervention may be needed)

### gh-make-release-openimis-json.py

Alternative release creation script that works with openimis.json configurations.

**Usage:**
```bash
python python/gh-make-release-openimis-json.py
```

**Similar to gh-make-release.py but uses different configuration sources.**

### gh-remove-main.py

Removes main branches from repositories (use with caution).

**Usage:**
```bash
python python/gh-remove-main.py
```

**What it does:**
- Deletes main branches from specified repositories
- Typically used for repository cleanup or migration

### gh-republish.py

Republishes packages to package registries.

**Usage:**
```bash
python python/gh-republish.py
```

**What it does:**
- Triggers republishing of packages to PyPI, npm, etc.
- Useful when package publishing failed initially

### gh-get-translations.py

Retrieves translation files from repositories.

**Usage:**
```bash
python python/gh-get-translations.py
```

**What it does:**
- Downloads translation files from frontend repositories
- Helps with localization management

## Troubleshooting

### Rate Limiting
GitHub API has rate limits. If you encounter rate limit errors:
- Increase the `TIMER` value in `config.py`
- Use a GitHub token with higher limits
- Wait and retry the operation

### Authentication Issues
- Ensure your `GITHUB_TOKEN` has `repo` scope
- Check that the token hasn't expired
- Verify your GitHub username is correct

### Branch Conflicts
- Use `gh-check-release-branch.py` before creating branches
- Resolve any existing conflicts manually before running scripts

### Permission Errors
- Ensure you have write access to the repositories
- Check that your token has the necessary permissions

## Advanced Usage

### Custom Repository Lists
You can modify the `REPOS` list in `config.py` to work with specific repositories only:

```python
REPOS = ['core', 'CoreModule']  # Only work with these modules
```

### Branch Configuration
Configure different branches for different components:

```python
BRANCH_SOL = 'develop'      # Solutions branch
BRANCH_FE = 'release/25.10' # Frontend branch
BRANCH_BE = 'develop'       # Backend branch
BRANCH = 'develop'          # Default branch
```

### Connection Mode
Choose between SSH and HTTPS for Git operations:

```python
MODE = 'ssh'  # or 'https'
```

## Contributing

When adding new release scripts:
1. Follow the existing naming convention (`gh-*.py`)
2. Include proper error handling
3. Add documentation to this file
4. Test with a small subset of repositories first