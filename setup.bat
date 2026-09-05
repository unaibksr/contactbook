@echo off
:: Quick setup script — initializes git, commits, and pushes.
:: Usage: setup.bat https://github.com/yourname/contactbook.git
setlocal
cd /d %~dp0

if "%~1"=="" (
    echo Usage: setup.bat https://github.com^<you^>/contactbook.git
    echo.
    echo Or run commands manually:
    echo   git init
    echo   git add .
    echo   git commit -m "Initial commit"
    echo   git branch -M main
    echo   git remote add origin ^<your-repo-url^>
    echo   git push -u origin main
    exit /b 1
)

git init
git add .
git commit -m "Initial commit with contacts"
git branch -M main
git remote add origin %1
git push -u origin main

echo.
echo Done! Your contacts.json is now on GitHub.
endlocal
