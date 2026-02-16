# openIMIS Development Tools

This repository group tools for developers to initialize and develop the openIMIS system. 

## Requirements

- Python 3.x
- GitPython (`pip install GitPython`)
- PyGithub (`pip install PyGithub`)
- Valid GitHub token with repo access permissions

## Development setting

### Cloning with frontend and backend

`git clone --recurse-submodules https://github.com/openimis/openimis-dev-tools.git`

### Configuration

Edit `python/config.py` to set:
- `GITHUB_TOKEN`: GitHub personal access token for API access
- `USER_NAME`: Your GitHub username
- `BRANCH`: Default branch to checkout (e.g., 'develop', 'release/25.10')
- `TIMER`: Delay between API calls to avoid rate limits

### Download the packages
```bash
cd openimis-dev-tools
pip install -r requirements.txt
python python/setup-local-dev.py
``` 

**Basic usage:**
```bash
python setup-local-dev.py
```

**With a solution name:**
```bash
python setup-local-dev.py CoreMIS
```

**Parameters:**
- `SOLUTION` (optional): Name of a solution from the `openimis/solutions` repository. If provided, loads BE and FE configurations from the solutions repo. If not provided, uses local `backend/openimis.json` and `frontend/openimis.json` files.
- `MODE` (optional, second argument): Connection mode for Git operations. Options:
  - `ssh` (default): Uses SSH URLs for cloning
  - Other modes use HTTPS with GitHub token authentication

**What it does:**
1. Loads backend and frontend module configurations
2. Clones or updates each module repository to the appropriate branch
3. Generates `backend/openimis-dev.json` and `frontend/openimis-dev.json` with local module paths
4. Backend modules are cloned to `backend-packages/`, frontend modules to `frontend-packages/`


### Developing locally

#### Run the Frontend locally
```bash
cd frontend
# install all modules
node dev_tools/entrypoint-dev.js 
# load the module in assembly
npm run load-config -c ./openimis.json
# install node packages
npm  install --include=dev --legacy-peer-deps
# run app (need backend up or error 500)
npm run start
```

#### Run the Backend locally 
 
PYTHON 3.11 or 3.12 recommended, 3.14 DOES NOT WORK!!!

```bash
cd backend
# install assembly requirements
pip install -r requirements.txt
# get the requirement for all modules
python script/modules-requirements.py ../openimis-dev.json > script/modules-requirements.txt
# install modules requirements
pip install -r script/modules-requirements.txt
# to addapt the script that was initially done for docker
sed -i 's#/\./#../#g' script/modules-requirements.txt
# to keep custom version of django-appscheduler working 
pip install "setuptools<81"
cd openIMIS
# apply migration
OPENIMIS_CONF=../openimis-dev.json python manage.py migrate
# launch openIMIS
OPENIMIS_CONF=../openimis-dev.json python manage.py runserver

```
### Starting docker

`docker compose up --build -d `

#### Docker Compose Configuration

The main `compose.yml` file uses Docker Compose's `extends` feature to reference service definitions from `compose-version.yml`. This allows for modular configuration of different environments and services.

- `compose.yml`: Main orchestration file that defines the services to run and their relationships.
- `compose-version.yml`: Contains detailed service configurations for backend, frontend, and database services in different modes (dev, prod, debug).

To run specific services, use profiles or service names. For example:
- `docker compose --profile migrations up migrations` - Run only migrations
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

## Python tools

### Config file
```
#person tocken
GITHUB_TOKEN=
#deprecated: list of module to take care of; now all module from openimis.json in the develop assembly are in
REPOS =  []
#name of the branche to create/chec ... 
RELEASE_NAME='release/23.04'
#to avoid too many request (Github block if not)
TIMER=5
```



### gh-check-release-branch

 Check if there is an existing branch

 ### gh-create-release-branch

 Create the release bracn from develop

### gh-get-translations

Get FE translation

### gh-make-release

Create github, pip and npm release packages


### gh-pr-develop-to-release

Create PR to merge dev to release

### gh-pr-release-to-main

Create PR to merge release to main

### make-links

Create docs

## Initializing modular openIMIS

First you need to install or access the legacy openIMIS (at least the DB for the BE).

Make sure you have python installed in your computer and the python command is accessible (python bin folder is in PATH).
