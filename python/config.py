import os

# Load secrets from .secrets file if it exists
def _load_secrets():
    secrets = {}
    # Try to find .secrets in the current directory or parent directories
    current_dir = os.path.dirname(os.path.abspath(__file__))
    possible_paths = [
        os.path.join(current_dir, '.secrets'),
        os.path.join(current_dir, '..', '.secrets'),
        os.path.join(os.getcwd(), '.secrets')
    ]
    for path in possible_paths:
        if os.path.exists(path):
            try:
                with open(path, 'r') as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#') and '=' in line:
                            key, val = line.split('=', 1)
                            key = key.strip()
                            val = val.strip().strip('"').strip("'")
                            secrets[key] = val
                break
            except Exception:
                pass
    return secrets

_secrets = _load_secrets()

GITHUB_TOKEN = _secrets.get("GITHUB_TOKEN", os.environ.get("GITHUB_TOKEN", ""))
USER_NAME = _secrets.get("USER_NAME", os.environ.get("USER_NAME", "delcroip"))

REPOS =  []
RELEASE_NAME='release/25.04'
BRANCH_SOL='develop'
BRANCH_FE='feature/vite-migration'
BRANCH_BE='feature/load-demo'
BRANCH='develop'
MODE = 'https' # or ssh
TIMER=5