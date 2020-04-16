# openIMIS Development Tools

This repository group tools for developers to initialize and develop the openIMIS system. 

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