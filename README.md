# openIMIS Development Tools

This repository group tools for developers to initialize and develop the openIMIS system. 


## Python tools

### config file
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

 check if there is an existing branch

 ### gh-create-release-branch

 create the release bracn from develop

### gh-get-translations

get FE translation

### gh-make-release

create github, pip and npm release packages


### gh-pr-develop-to-release

create PR to merge dev to release

### gh-pr-release-to-main

create PR to merge release to main

### make-links

create docs

## Initializing modular openIMIS

First you need to install or access the legacy openIMIS (at least the DB for the BE).

Make sure you have python installed in your computer and the python command is accessible (python bin folder is in PATH).

### Initializing modular BE in Windows


First download this repository to your computer (i.e. C:\openimis-dev-tools). 

Edit the ```windows\install_openimis_dev.ps1``` and change the database connection parameters, the Django superuser account and the installation folder. Other parameters can be modified.

```
$db_host="mssql-host-server"
$db_port="1433"
$db_name="database-name"
$db_user="database-user"
$db_password="database-password"

$DJANGO_SUPERUSER_USERNAME="spiderman"
$DJANGO_SUPERUSER_PASSWORD="spiderman"
$DJANGO_SUPERUSER_EMAIL="spiderman@openimis.org"

$project_dir = "C:\openIMIS"
```

Open a powershell console and execute following commands (please adapt with your download folder). You might need to use an administrator account or open the powershell with administrator rights. 

```
cd C:\openimis-dev-tools\windows 
. install_openimis_dev.ps1
init-be-environment
run-be
```

By default, openIMIS will be initialized in ```C:\openIMIS``` folder. 