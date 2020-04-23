# To run this file you will need to open Powershell as administrator and first run:
# Set-ExecutionPolicy Unrestricted
# Then source this script by running:
# . .\install_openimis_dev.ps1

$db_host="mssql-host-server"
$db_port="1433"
$db_name="database-name"
$db_user="database-user"
$db_password="database-password"

$DJANGO_SUPERUSER_USERNAME="spiderman"
$DJANGO_SUPERUSER_PASSWORD="spiderman"
$DJANGO_SUPERUSER_EMAIL="spiderman@openimis.org"


$project_dir = "C:\openIMIS"

$virtualenv_dir = "venv"

$be_dir = "$project_dir\openIMIS-be"
$fe_dir = "$project_dir\openIMIS-fe"

$be_modules_dir = "$be_dir\modules"
$fe_modules_dir = "$fe_dir\modules"

$be_assembly = "openimis-be_py"
$fe_assembly = "openimis-fe_js"
$git_branch = "develop"

$gettext_output = "$project_dir\tools\gettext"

$python_version = "3.8.2"
$gettext_version = "0.19.8.1"

$save_dir=Resolve-Path ~/Downloads

$client = New-Object System.Net.WebClient

$env:GIT_REDIRECT_STDERR = '2>&1'

function InstallPythonMSI($installer) {
	$Arguments = @()
	$Arguments += "/i"
	$Arguments += "`"$installer`""
	$Arguments += "ALLUSERS=`"1`""
	$Arguments += "/passive"

	Start-Process "msiexec.exe" -ArgumentList $Arguments -Wait
}

function download-file([string]$url, [string]$d) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
	# Downloads a file if it doesn't already exist
	if(!(Test-Path $d -pathType leaf)) {
		# get the file
		write-host "Downloading $url to $d";
		$client.DownloadFile($url, $d);
	}
}

function test-save-dir {
    if(!(Test-Path -pathType container $save_dir)) {
		write-host -fore red $save_dir " does not exist";
		exit;
	}
}

function get-python-ver([Parameter(mandatory=$false)] [String]$version) {
	# Download Python indicated by version. For example:
	#  > get-python-ver 3.4.0rc1
	# or
	#  > get-python-ver 2.7.6

	if ($version -ne $null) {
        $version = $python_version;
		
	}
    $filename = 'python-' + $version + '.amd64.msi';
	$save_path = '' + $save_dir + '\' + $filename;
    test-save-dir

	$url = 'http://www.python.org/ftp/python/' + $version.Substring(0,5) + '/amd64/exe.msi'; # + $filename;
	download-file $url $save_path
	write-host "Installing Python"
    $target_dir = 'C:\Python' + $version + '\';
	InstallPythonMSI $save_path $target_dir

	write-host "Add Python to the PATH"
	[Environment]::SetEnvironmentVariable("Path", "$env:Path;$target_dir;$target_dir"+"Scripts\", "User")
}

function get-setuptools {
	write-host "Installing setuptools"
	$setuptools_url = "https://bitbucket.org/pypa/setuptools/raw/bootstrap/ez_setup.py"
	$ez_setup = '' + $save_dir + "\ez_setup.py"
	download_file $setuptools_url $ez_setup
	python $ez_setup
}

function get-pip {
	write-host "Installing pip"

    if ((Get-Command "pip.exe" -ErrorAction SilentlyContinue)  -eq $null) { 
        $setuptools_url = "https://raw.github.com/pypa/pip/master/contrib/get-pip.py"
	    $get_pip = '' + $save_dir + "\get_pip.py"
	    download_file $setuptools_url $get_pip
	    python $get_pip
    }
    else {
        write-host "pip already installed. upgrading..."
        python -m pip install --upgrade pip
    }
}

function create-venv {
	write-host "Installing virtualenv"
	pip install virtualenv
	# pip install virtualenvwrapper-win $virtualenv_dir
	Set-Location -Path $project_dir
    python -m venv $virtualenv_dir
    [Environment]::SetEnvironmentVariable("WORKON_HOME", "$project_dir\$virtualenv_dir", "User")
}

function get-git {
	write-host "Installing git"
	$url = "https://msysgit.googlecode.com/files/Git-1.8.5.2-preview20131230.exe"
	$dest = '' + $save_dir + "\Git-1.8.5.2-preview20131230.exe"
	download_file $url $dest
	Start-Process $dest -ArgumentList "/silent" -Wait
	[Environment]::SetEnvironmentVariable("Path", "$env:Path;C:\Program Files (x86)\Git\bin\", "User")
}

function get-chocolately {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;
    Invoke-WebRequest -Uri "https://chocolatey.org/install.ps1" -UseBasicParsing | iex
}

function get-gettext {
    $gettext_url="https://github.com/vslavik/gettext-tools-windows/releases/download/v$GETTEXT_VERSION/gettext-tools-windows-$GETTEXT_VERSION.zip"
    $gettext_file = "$save_dir\gettext.zip"
    
    test-save-dir
    Invoke-WebRequest -Uri $gettext_url -OutFile $gettext_file
    Expand-Archive -Path $gettext_file -DestinationPath $gettext_output -Force
    # TODO add validation if folder not in Path
    [Environment]::SetEnvironmentVariable("Path", "$env:Path;$gettext_output\bin\", "Machine")
}

function create-be-dirs {
	write-host "Creating directories"
	if(!(Test-Path -pathType container $project_dir)) {
        New-Item -ItemType directory -Path $project_dir
    }
	if(!(Test-Path -pathType container $be_dir)) {
        New-Item -ItemType directory -Path $be_dir
    }
	if(!(Test-Path -pathType container $be_modules_dir)) {
        New-Item -ItemType directory -Path $be_modules_dir
    }
}

function create-fe-dirs {
	write-host "Creating directories"
	if(!(Test-Path -pathType container $project_dir)) {
        New-Item -ItemType directory -Path $project_dir
    }
	if(!(Test-Path -pathType container $fe_dir)) {
        New-Item -ItemType directory -Path $fe_dir
    }
	if(!(Test-Path -pathType container $fe_modules_dir)) {
        New-Item -ItemType directory -Path $fe_modules_dir
    }
}

function upgrade-pip($virtualenv) {
	$scripts = $virtualenv_dir + "\" + $virtualenv + "\Scripts\"
	$activate = $scripts + "activate.ps1"
	. $activate
	get_setuptools
	get_pip
}
	
function install-pywin32($virtualenv) {
	$url = "http://downloads.sourceforge.net/project/pywin32/pywin32/Build%20218/pywin32-218.win32-py2.7.exe"
	$dest = '' + $save_dir + "pywin32-218.win32-py2.7.exe"
	download_file $url $dest

	$scripts = $virtualenv_dir + "\" + $virtualenv + "\Scripts\"
	$activate = $scripts + "activate.ps1"
	. $activate
	easy_install $dest
}


function activate-venv() {
    $scripts = $project_dir + "\" + $virtualenv_dir + "\Scripts\"
	$activate = $scripts + "activate.ps1"
	. $activate
}

function get-openimis-repo([String]$name, [String]$dest) {
    $current_dir = $PWD
    $dest = "$dest\$name"
    # Set-Location -Path $dest
    if (!(Test-Path -Path $dest\*)) { 
        git clone https://github.com/openimis/$name.git -b $git_branch $dest
    }
    else {
 	    write-host "Repository $name exists. Pulling last $git_branch branch..."     
        Set-Location -Path $dest
        git fetch
        git checkout $git_branch  
        git pull 
    }
    $current_dir | Set-Location
}

function create-django-superuser ($username, $email, $password) {
    Remove-Item -Path "django-superuser.py" 

    Add-Content -Path "django-superuser.py" -Value "import os, django"
    Add-Content -Path "django-superuser.py" -Value "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'openIMIS.settings')"
    Add-Content -Path "django-superuser.py" -Value "django.setup()"
    Add-Content -Path "django-superuser.py" -Value "from django.contrib.auth import get_user_model"
    Add-Content -Path "django-superuser.py" -Value "User = get_user_model()"
    Add-Content -Path "django-superuser.py" -Value "if not User.objects.filter(username='$username').exists():"
    Add-Content -Path "django-superuser.py" -Value "    User.objects.create_superuser(username='$username', email='$email', password='$password')"
    Add-Content -Path "django-superuser.py" -Value "else: "
    Add-Content -Path "django-superuser.py" -Value "    print('User ""{}"" exists already, not created'.format('$username'))"
    
    python "django-superuser.py"

    Remove-Item -Path "django-superuser.py" 
}

# to remove
function init-python-environment() {
    get-pip
    #create-directories
    get-virtualenv 
}

function init-be-environment() {
    Write-Host "Initializing the BE modules..."

    get-pip
    create-be-dirs
    create-venv 

    # clone the be assembly 
    Write-Host "Copying '$be_assembly' assembly..."
    get-openimis-repo $be_assembly $be_dir
    Set-Location -Path "$be_dir\$be_assembly"

    # activate venv and update pip
    Write-Host "Activating virtual environment..."
    activate-venv
    python -m pip install --upgrade pip

    # install python modules and generate the openIMIS module list 
    Write-Host "Installing python modules..."
    pip install -r requirements.txt
    python modules-requirements.py openimis.json > modules-requirements.txt
    
    # install openIMIS modules
    $modules = Get-Content -Path .\modules-requirements.txt
    $modules | ForEach-Object {
        $module = $_.ToString().Split('==')[0]
        Write-Host "Adding module '$module'..."
        $module_git = $module + "_py"
        get-openimis-repo $module_git $be_modules_dir
        pip uninstall $module --yes
        pip install -e "$be_modules_dir\$module_git\"
    }

    Write-Host "Creating database configuration file..."
    Set-Location -Path "$be_dir\$be_assembly"
    Remove-Item -Path ".env" 
    Add-Content -Path ".env" -Value "DB_HOST=$db_host"
    Add-Content -Path ".env" -Value "DB_PORT=$db_port"
    Add-Content -Path ".env" -Value "DB_NAME=$db_name"
    Add-Content -Path ".env" -Value "DB_USER=$db_user"
    Add-Content -Path ".env" -Value "DB_PASSWORD=$db_password"

    Write-Host "Applying database migrations..."
    Set-Location -Path "$be_dir\$be_assembly\openIMIS"
    python manage.py migrate
    
    Write-Host "Creating Django superuser..."
    create-django-superuser $DJANGO_SUPERUSER_USERNAME $DJANGO_SUPERUSER_EMAIL $DJANGO_SUPERUSER_PASSWORD

    Write-Host "Preparing the code..."
    get-gettext
   	$env:Path="$env:Path;$gettext_output\bin\"
    $env:NO_DATABASE=1 
    python manage.py compilemessages
    python manage.py collectstatic --clear --noinput
    $env:NO_DATABASE=0

    Write-Host "To start the BE just execute:"
    Write-Host "    run-be"
}

function run-be {
    # activate venv
    activate-venv

    Set-Location -Path "$be_dir\$be_assembly\openIMIS"
    python manage.py runserver --noreload
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12