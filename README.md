# OpenIMIS Development Tools

This repository provides tools and scripts to help developers set up and work on the openIMIS system, a modular social protection management information system.

## Quick Start for New Developers

### Prerequisites

Before you begin, ensure you have the following installed:

- **Python 3.11** (3.14 is not supported, recent dependency update broke compatibility with python 3.12)
- **Git** with SSH access to GitHub
- **Node.js** (for frontend development)
- **Docker and Docker Compose** (for containerized development)
- **GitHub Personal Access Token** with `repo` permissions

### Step 1: Clone the Repository

```bash
git clone --recurse-submodules https://github.com/openimis/openimis-dev-tools.git
cd openimis-dev-tools
```

### Step 2: Install Python Dependencies

```bash
pip install -r requirements.txt
```

### Step 3: Configure Your Environment

#### Create GitHub Personal Access Token

You need a GitHub Personal Access Token to access OpenIMIS repositories:

1. Go to [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Give it a descriptive name (e.g., "openIMIS Development")
4. Select the `repo` scope (full control of private repositories)
5. Click "Generate token"
6. **Copy the token immediately** - you won't be able to see it again!

#### Configure config.py

Edit `python/config.py` with your settings:

```python
# Your GitHub personal access token
GITHUB_TOKEN = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Your GitHub username
USER_NAME = "your-github-username"

# Default branch to checkout
BRANCH = "develop"

# Connection mode: 'ssh' or 'https'
# ssh has stronger security and make sending back change on github easier
# one need to add his local public key on github
MODE = 'ssh'
```

**Important:** Keep your token secure and never commit it to version control.

### Step 4: Set Up Development Environment

#### Option A: Automated Setup (Recommended)

```bash
python python/setup-local-dev.py
```

This will:
- Clone all OpenIMIS backend and frontend modules
- Set up local development configurations
- Generate `backend/openimis-dev.json` and `frontend/openimis-dev.json`

#### Option B: Manual Setup

If you prefer more control, follow the detailed setup guides below.

### Step 5: Start Developing

Choose your development approach:

- **Docker Development** (easiest): Use Docker Compose for isolated development
- **Local Development** (advanced): Set up services directly on your machine

## Detailed Configuration

### Understanding config.py Variables

The `python/config.py` file contains several important settings:

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_TOKEN` | Your GitHub personal access token | `"ghp_xxx..."` |
| `USER_NAME` | Your GitHub username | `"johndoe"` |
| `BRANCH` | Default branch for checkouts | `"develop"` |
| `BRANCH_SOL` | Solutions repository branch | `"develop"` |
| `BRANCH_FE` | Frontend modules branch | `"develop"` |
| `BRANCH_BE` | Backend modules branch | `"develop"` |
| `RELEASE_NAME` | Release branch name | `"release/25.10"` |
| `REPOS` | Specific repositories to work with | `['core', 'CoreModule']` |
| `MODE` | Git connection mode | `'ssh'` or `'https'` |


### Understanding "Locks" in OpenIMIS

OpenIMIS uses version constraints to ensure compatibility:

#### Version Locks in Dependencies
Some packages have strict version requirements due to compatibility issues:
- `setuptools<81` - Required for django-appscheduler compatibility
- Specific Python version requirements (3.11, not 3.14)

#### Lock Files
The project uses lock files to ensure reproducible builds:
- `requirements.txt` - Python dependencies
- `package-lock.json` - Node.js dependencies
- `openimis-dev.lock` - Module-specific requirements

These locks prevent unexpected updates that could break the system.

## Development Setup Options

### Local Development (Advanced)

If you prefer to run services directly on your machine instead of using Docker:

#### Frontend Setup

```bash
cd frontend
# Install all modules
node dev_tools/entrypoint-dev.js -c ./openimis-dev.json
# Load module configuration
npm run load-config -c ./openimis-dev.json
# Install dependencies (use legacy peer deps to avoid conflicts)
npm install --include=dev --legacy-peer-deps
# Start development server (requires backend to be running)
npm run start
```

The frontend will be available at `http://localhost:3000`.

#### Backend Setup

**Important:** Use Python 3.11 or 3.12 (3.14 is not supported)

```bash
cd backend
# Install base requirements
pip install -r requirements.txt
# Generate module-specific requirements
python script/modules-requirements.py ../openimis-dev.json > script/modules-requirements.txt
# Install module requirements
pip install -r script/modules-requirements.txt
# Fix path references for local development
sed -i 's#/\./#../#g' script/modules-requirements.txt
# Install specific setuptools version for compatibility
pip install "setuptools<81"
# Change to Django project directory
cd openIMIS
# Run database migrations
OPENIMIS_CONF=../openimis-dev.json python manage.py migrate
# Start Django development server
OPENIMIS_CONF=../openimis-dev.json python manage.py runserver
```

The backend will be available at `http://localhost:8000`.
### starting docker

`docker compose up --build -d `

#### Docker Compose Configuration

The main `compose.yml` file uses Docker Compose's `extends` feature to reference service definitions from `compose-version.yml`. This allows for modular configuration of different environments and services.

- `compose.yml`: Main orchestration file that defines the services to run and their relationships.
- `compose-version.yml`: Contains detailed service configurations for backend, frontend, and database services in different modes (dev, prod, debug).

To run specific services, use profiles or service names. For example:
- `docker compose up migrations` - Run only migrations, not run by default
- `docker compose up backend frontend` - Run specific services

#### Available Services

| Service Name | Type | Environment | Description |
|--------------|------|-------------|-------------|
| `migrations-dev` | Backend | Development | Runs database migrations and initial setup. Installs Python modules into shared venv. |
| `backend-dev` | Backend | Development | Django development server with auto-reload. Uses shared venv for modules. |
| `backend-debug` | Backend | Debug | Django server with debugpy for remote debugging. Uses shared venv for modules. |
| `backend-prod` | Backend | Production | Production-ready Django server with gunicorn. |
| `frontend-dev` | Frontend | Development | React development server with hot reload. |
| `frontend-prod` | Frontend | Production | Nginx serving built React application. |
| `db` | Database | N/A | PostgreSQL database server. |
| `db-mssql` | Database | N/A | Microsoft SQL Server database server. |

#### Shared Virtual Environment for Backend Containers

The backend containers (migrations, backend-dev, backend-debug) now use a shared virtual environment volume (`venv`) to store installed Python modules. This prevents the need to reinstall modules each time a container starts, improving startup times and avoiding import failures.

- The `venv` volume is automatically created and mounted at `/venv` in the containers.
- Modules are installed into this shared environment, so once installed by one container (e.g., migrations), they are available to others.
- If you need to clear the installed modules, remove the `venv` volume: `docker compose down -v` (this will remove all volumes).

## Release Management

For information about release management scripts and workflows, see [RELEASE.md](RELEASE.md).

## Troubleshooting

### Common Issues

### reverse proxy Issues

- **frontend dev mode** vite is managing the reverse proxy, one need to change the backend `/api` target in frontend/vite.config.js
- **frontend prod mode** nginx is managing the reverse proxy, one need to update the nginx `/api` location to targer the backend

#### GitHub Token Issues
- **"Bad credentials" error**: Verify your token is correct and has `repo` scope
- **Permission denied**: Ensure your token has access to OpenIMIS repositories

#### Python Version Issues
- **Python 3.14 not supported**: Use Python 3.11 
- **Import errors**: Ensure all dependencies are installed: `pip install -r requirements.txt`

#### Docker Issues
- **Port conflicts**: Check if ports 3000 (frontend) or 8000 (backend) are in use
- **Volume permissions**: On Linux, you may need to adjust Docker volume permissions
- **Memory issues**: Ensure Docker has enough memory allocated (4GB recommended)

#### Module Installation Issues
- **npm install fails**: Try `npm install --legacy-peer-deps`
- **pip install fails**: Check Python version compatibility
- **Version conflicts**: Some packages have strict version requirements (see "Locks" section)

### Getting Help

- Check existing GitHub issues in the [openimis-dev-tools repository](https://github.com/openimis/openimis-dev-tools/issues)
- Review the [OpenIMIS documentation](https://openimis.atlassian.net/wiki/spaces/OP/pages/1174401/Technical+Documentation)
- Join the [OpenIMIS community forum](https://openimis.org/community/)

### Development Tips

- Use the automated setup script for first-time setup
- Keep your GitHub token secure and rotate it regularly
- Use Docker for isolated development to avoid conflicts
- Test changes across both frontend and backend
- Follow the modular architecture when adding new features

## Project Structure

After running the setup script, your directory structure will look like this:

```
openimis-dev-tools/
├── backend/                 # Django backend application
│   ├── openIMIS/           # Main Django project
│   └── openimis-dev.json   # Local backend configuration
├── backend-packages/       # Cloned backend modules
├── frontend/               # React frontend application
│   └── openimis-dev.json   # Local frontend configuration
├── frontend-packages/      # Cloned frontend modules
├── python/                 # Development and release scripts
├── RELEASE.md              # Release management documentation
└── compose.yml            # Docker Compose configuration
```

## Contributing

We welcome contributions to OpenIMIS! Please:

1. Fork the repository
2. Create a feature branch from `develop`
3. Make your changes
4. Test thoroughly across frontend and backend
5. Submit a pull request

For more information, see the [OpenIMIS contribution guidelines](https://github.com/openimis/openimis-be_py/blob/develop/CONTRIBUTING.md).
