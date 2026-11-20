# release_apk.ps1 - build APK rilis Rust lalu unggah ke Google Drive (seru24/app/seru24-rust.apk).
#   .\release_apk.ps1             -> build versi saat ini (mulai versi 2), lalu unggah ke seru24-rust.apk
#   .\release_apk.ps1 -Bump       -> naikkan versi (2 -> 3, dst.), build, lalu unggah
#   .\release_apk.ps1 -SkipBuild  -> unggah APK versi sekarang tanpa build ulang
# Terpisah dari release_apk.ps1 milik React Native (seru24.apk / seru24_kind='android_apk').
param(
    [switch]$SkipBuild,
    [switch]$Bump
)

$ErrorActionPreference = 'Stop'
$RustDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $RustDir
$api = 'https://www.googleapis.com/drive/v3'
$uploadApi = 'https://www.googleapis.com/upload/drive/v3'
$apkMime = 'application/vnd.android.package-archive'
$kindValue = 'android_rust_apk'
$kindQuery = "appProperties has { key='seru24_kind' and value='$kindValue' }"

function Read-DotEnv([string]$path) {
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($path)) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
    }
    return $values
}

$envValues = Read-DotEnv (Join-Path $RepoRoot 'web\.env')
foreach ($key in 'NUXT_GDRIVE_CLIENT_ID', 'NUXT_GDRIVE_CLIENT_SECRET', 'NUXT_GDRIVE_REFRESH_TOKEN') {
    if (-not $envValues[$key]) { throw "$key kosong di web\.env" }
}

if (-not $SkipBuild) {
    if ($Bump) {
        & (Join-Path $RustDir 'build.ps1') -Bump
    } else {
        & (Join-Path $RustDir 'build.ps1')
    }
    if ($LASTEXITCODE -ne 0) { Write-Host 'Build Rust gagal, rilis dibatalkan.' -ForegroundColor Red; exit 1 }
}

$gradle = [IO.File]::ReadAllText((Join-Path $RustDir 'android\app\build.gradle'))
$code = [int]([regex]::Match($gradle, 'versionCode\s*=\s*(\d+)').Groups[1].Value)
$name = [regex]::Match($gradle, 'versionName\s*=\s*"([^"]+)"').Groups[1].Value
$apk = Join-Path $RustDir "seru24-rust-$code.apk"
if (-not (Test-Path $apk)) { throw "APK tidak ditemukan: $apk (jalankan tanpa -SkipBuild)" }

$token = (Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' -Body @{
    client_id     = $envValues['NUXT_GDRIVE_CLIENT_ID']
    client_secret = $envValues['NUXT_GDRIVE_CLIENT_SECRET']
    refresh_token = $envValues['NUXT_GDRIVE_REFRESH_TOKEN']
    grant_type    = 'refresh_token'
}).access_token
$auth = @{ Authorization = "Bearer $token" }

function Find-Files([string]$q) {
    $uri = "$api/files?q=$([uri]::EscapeDataString($q))&fields=files(id)&pageSize=1"
    return ,@((Invoke-RestMethod -Uri $uri -Headers $auth).files)
}

function Get-Folder([string]$folderName, [string]$parent) {
    $found = Find-Files "name = '$folderName' and mimeType = 'application/vnd.google-apps.folder' and '$parent' in parents and trashed = false"
    if ($found.Count -gt 0) { return $found[0].id }
    $body = @{ name = $folderName; mimeType = 'application/vnd.google-apps.folder'; parents = @($parent) } | ConvertTo-Json
    return (Invoke-RestMethod -Method Post -Uri "$api/files?fields=id" -Headers $auth -ContentType 'application/json' -Body $body).id
}

$sha256 = (Get-FileHash -Algorithm SHA256 $apk).Hash.ToLowerInvariant()
$appFolderId = Get-Folder 'app' (Get-Folder 'seru24' 'root')
$existing = Find-Files "$kindQuery and trashed = false"
if ($existing.Count -eq 0) {
    $existing = Find-Files "name = 'seru24-rust.apk' and '$appFolderId' in parents and trashed = false"
}
$meta = @{
    name          = 'seru24-rust.apk'
    mimeType      = $apkMime
    appProperties = @{ seru24_kind = $kindValue; version_code = "$code"; version_name = $name; sha256 = $sha256 }
}
if ($existing.Count -gt 0) {
    $fileId = $existing[0].id
    $sessionUri = "$uploadApi/files/$fileId`?uploadType=resumable&fields=id"
    $method = 'Patch'
} else {
    $meta.parents = @($appFolderId)
    $sessionUri = "$uploadApi/files?uploadType=resumable&fields=id"
    $method = 'Post'
}

$size = (Get-Item $apk).Length
$session = Invoke-WebRequest -UseBasicParsing -Method $method -Uri $sessionUri -Headers ($auth + @{
    'X-Upload-Content-Type'   = $apkMime
    'X-Upload-Content-Length' = "$size"
}) -ContentType 'application/json; charset=UTF-8' -Body ($meta | ConvertTo-Json -Depth 4)
$location = $session.Headers['Location']
Write-Host "Mengunggah seru24-rust-$code.apk ($([math]::Round($size / 1MB, 2)) MB) ke Google Drive sebagai seru24-rust.apk..."
$fileId = ((Invoke-WebRequest -UseBasicParsing -Method Put -Uri $location -InFile $apk -ContentType $apkMime).Content | ConvertFrom-Json).id

$permission = @{ role = 'reader'; type = 'anyone' } | ConvertTo-Json
$null = Invoke-RestMethod -Method Post -Uri "$api/files/$fileId/permissions" -Headers $auth -ContentType 'application/json' -Body $permission

Write-Host "`nRilis Rust $name (build $code) terunggah sebagai seru24-rust.apk." -ForegroundColor Green
Write-Host "Link unduh: https://drive.google.com/file/d/$fileId/view"
Write-Host "Download langsung: https://drive.usercontent.google.com/download?id=$fileId&export=download&confirm=t"
Write-Host "SHA-256: $sha256"
