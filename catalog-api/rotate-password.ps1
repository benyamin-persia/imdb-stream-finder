# Requires: atlas auth login (browser) once, then this script rotates the DB user password via CLI.
$ErrorActionPreference = "Stop"
$UserName = "benyaminmohamadalizadeh_db_user"
$EnvFile = Join-Path $PSScriptRoot ".env"

atlas auth whoami | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Run: atlas auth login   (complete browser login), then re-run this script."
  exit 1
}

$projects = atlas projects list -o json | ConvertFrom-Json
$projectId = $projects.results[0].id
if (-not $projectId) { throw "No Atlas project found" }

Add-Type -AssemblyName System.Security
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$newPass = ([Convert]::ToBase64String($bytes) -replace '[+/=]','') + "Aa1!"

atlas dbusers update $UserName --password $newPass --projectId $projectId
if ($LASTEXITCODE -ne 0) { throw "atlas dbusers update failed" }

# Rewrite MONGODB_URI password in .env
$uriLine = Get-Content $EnvFile | Where-Object { $_ -match '^MONGODB_URI=' } | Select-Object -First 1
if (-not $uriLine) { throw "MONGODB_URI missing in .env" }
$oldUri = $uriLine.Substring("MONGODB_URI=".Length)
$newUri = [regex]::Replace($oldUri, '(mongodb\+srv://[^:]+:)[^@]+(@)', { param($m) $m.Groups[1].Value + $newPass + $m.Groups[2].Value })
(Get-Content $EnvFile) | ForEach-Object {
  if ($_ -match '^MONGODB_URI=') { "MONGODB_URI=$newUri" } else { $_ }
} | Set-Content -Encoding UTF8 $EnvFile

Write-Host "Password rotated and catalog-api/.env updated. Restart: npm start"
