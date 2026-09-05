# ============================================================
# Push contacts.json to GitHub
# Run this any time you want to back up your latest contacts.
# Usage: powershell -ExecutionPolicy Bypass -File .\push.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

# Stage just the file we care about (so random runtime files don't sneak in)
git add contacts.json
git add index.html styles.css app.js .gitignore README.md

# Skip commit if nothing changed
$diff = git diff --cached --stat
if (-not $diff) {
    Write-Host "No changes to contacts.json — nothing to push." -ForegroundColor Yellow
    exit 0
}

Write-Host "Staged changes:" -ForegroundColor Cyan
Write-Host $diff

# Commit with a timestamp
$ts = Get-Date -Format "yyyy-MM-dd HH:mm"
git commit -m "contacts: update ($ts)"

# Push
try {
    git push
    Write-Host "`n✓ Pushed to GitHub." -ForegroundColor Green
} catch {
    Write-Host "`nPush failed. Make sure you have a remote configured:" -ForegroundColor Red
    Write-Host "  git remote add origin https://github.com/<you>/<repo>.git" -ForegroundColor Yellow
    Write-Host "  git branch -M main" -ForegroundColor Yellow
    exit 1
}
