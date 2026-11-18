# release_apk.ps1 - build APK rilis lalu unggah ke Google Drive akun penyimpanan (seru24/app/seru24.apk).
#   .\release_apk.ps1             -> naikkan versi, build (mobile\build.ps1), unggah
#   .\release_apk.ps1 -SkipBuild  -> unggah APK versi sekarang tanpa build ulang
# File di Drive selalu sama (link tidak berubah); versinya disimpan di appProperties dan dibaca /api/app/latest,
# sehingga aplikasi menampilkan peringatan "versi baru" dengan link yang sama.
# Kredensial OAuth Drive dibaca dari web\.env (NUXT_GDRIVE_*), tidak pernah ditulis di skrip ini.
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$api = 'https://www.googleapis.com/drive/v3'
$uploadApi = 'https://www.googleapis.com/upload/drive/v3'
$apkMime = 'application/vnd.android.package-archive'
$kind = "appProperties has { key='seru24_kind' and value='android_apk' }"

function Read-DotEnv([string]$path) {
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($path)) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
    }
    return $values
}

$envValues = Read-DotEnv (Join-Path $root 'web\.env')
foreach ($key in 'NUXT_GDRIVE_CLIENT_ID', 'NUXT_GDRIVE_CLIENT_SECRET', 'NUXT_GDRIVE_REFRESH_TOKEN') {
    if (-not $envValues[$key]) { throw "$key kosong di web\.env" }
}

if (-not $SkipBuild) {
    & (Join-Path $root 'mobile\build.ps1')
    if ($LASTEXITCODE -ne 0) { Write-Host 'Build gagal, rilis dibatalkan.' -ForegroundColor Red; exit 1 }
}

$gradle = [IO.File]::ReadAllText((Join-Path $root 'mobile\android\app\build.gradle'))
$code = [int]([regex]::Match($gradle, 'versionCode\s+(\d+)').Groups[1].Value)
$name = [regex]::Match($gradle, 'versionName\s+"([^"]+)"').Groups[1].Value
$apk = Join-Path $root "mobile\seru24-$code.apk"
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
    # koma: tetap array walau isinya satu (tanpa ini PowerShell 5.1 membukanya jadi objek tunggal tanpa .Count,
    # sehingga file/folder lama dianggap tidak ada dan setiap rilis membuat salinan baru)
    return ,@((Invoke-RestMethod -Uri $uri -Headers $auth).files)
}

function Get-Folder([string]$folderName, [string]$parent) {
    $found = Find-Files "name = '$folderName' and mimeType = 'application/vnd.google-apps.folder' and '$parent' in parents and trashed = false"
    if ($found.Count -gt 0) { return $found[0].id }
    $body = @{ name = $folderName; mimeType = 'application/vnd.google-apps.folder'; parents = @($parent) } | ConvertTo-Json
    return (Invoke-RestMethod -Method Post -Uri "$api/files?fields=id" -Headers $auth -ContentType 'application/json' -Body $body).id
}

# SHA-256 diperiksa aplikasi sebelum memasang pembaruan (OWASP ASVS V10.3.2)
$sha256 = (Get-FileHash -Algorithm SHA256 $apk).Hash.ToLowerInvariant()
$existing = Find-Files "$kind and trashed = false"
$meta = @{
    name          = 'seru24.apk'
    mimeType      = $apkMime
    appProperties = @{ seru24_kind = 'android_apk'; version_code = "$code"; version_name = $name; sha256 = $sha256 }
}
if ($existing.Count -gt 0) {
    # file lama ditimpa isinya: id dan link Drive tetap sama
    $fileId = $existing[0].id
    $sessionUri = "$uploadApi/files/$fileId`?uploadType=resumable&fields=id"
    $method = 'Patch'
} else {
    $meta.parents = @(Get-Folder 'app' (Get-Folder 'seru24' 'root'))
    $sessionUri = "$uploadApi/files?uploadType=resumable&fields=id"
    $method = 'Post'
}

$size = (Get-Item $apk).Length
$session = Invoke-WebRequest -UseBasicParsing -Method $method -Uri $sessionUri -Headers ($auth + @{
    'X-Upload-Content-Type'   = $apkMime
    'X-Upload-Content-Length' = "$size"
}) -ContentType 'application/json; charset=UTF-8' -Body ($meta | ConvertTo-Json -Depth 4)
$location = $session.Headers['Location']
Write-Host "Mengunggah seru24-$code.apk ($([math]::Round($size / 1MB, 2)) MB) ke Google Drive..."
$fileId = ((Invoke-WebRequest -UseBasicParsing -Method Put -Uri $location -InFile $apk -ContentType $apkMime).Content | ConvertFrom-Json).id

# siapa pun yang punya link bisa mengunduh (isi APK hanya nilai publik dari mobile\.env)
$permission = @{ role = 'reader'; type = 'anyone' } | ConvertTo-Json
$null = Invoke-RestMethod -Method Post -Uri "$api/files/$fileId/permissions" -Headers $auth -ContentType 'application/json' -Body $permission

Write-Host "`nRilis $name (build $code) terunggah." -ForegroundColor Green
Write-Host "Link unduh (tetap sama setiap rilis): https://drive.google.com/file/d/$fileId/view"
Write-Host 'Aplikasi versi lama akan menampilkan peringatan pembaruan dalam beberapa menit (cache /api/app/latest).'
