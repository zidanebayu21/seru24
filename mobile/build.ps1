# build.ps1 - build APK rilis seru24 (arm64, minify, shrinkResources), pola sama dengan testmobile.
#   .\build.ps1            -> naikkan versi, build, salin seru24-<versi>.apk ke folder ini
#   .\build.ps1 -Emulator  -> build x86_64 untuk emulator (tanpa menaikkan versi)
param([switch]$Emulator)

$ErrorActionPreference = 'Stop'
$startTime = Get-Date
$maxMb = 20
Set-Location $PSScriptRoot

node scripts/gen-env.js
if ($LASTEXITCODE -ne 0) { exit 1 }

$gradlePath = 'android/app/build.gradle'
$gradle = [IO.File]::ReadAllText((Resolve-Path $gradlePath))
$code = [int]([regex]::Match($gradle, 'versionCode\s+(\d+)').Groups[1].Value)

if (-not $Emulator) {
    $code++
    $gradle = $gradle -replace 'versionCode\s+\d+', "versionCode $code"
    $gradle = $gradle -replace 'versionName\s+"[^"]+"', "versionName `"1.$code`""
    [IO.File]::WriteAllText((Resolve-Path $gradlePath), $gradle)
    Write-Host "Versi: 1.$code (build $code)" -ForegroundColor Yellow
}

$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$arch = if ($Emulator) { 'x86_64' } else { 'arm64-v8a' }
Push-Location android
# peringatan Gradle ditulis ke stderr; jangan dianggap error oleh PowerShell 5.1
$ErrorActionPreference = 'Continue'
& .\gradlew.bat assembleRelease "-PreactNativeArchitectures=$arch" --console=plain 2>&1 | Out-Host
$ok = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
Pop-Location
if (-not $ok) { Write-Host 'Build gagal.' -ForegroundColor Red; exit 1 }

$apk = Get-Item "android/app/build/outputs/apk/release/seru24-$code.apk"
$target = if ($Emulator) { "seru24-$code-emulator.apk" } else { "seru24-$code.apk" }
Copy-Item $apk.FullName $target -Force
$sizeMb = [math]::Round($apk.Length / 1MB, 2)

Write-Host "`nAPK: $target ($sizeMb MB, $arch)" -ForegroundColor Green
Write-Host "Durasi: $([int]((Get-Date) - $startTime).TotalSeconds) detik"
if ($sizeMb -ge $maxMb) { Write-Host "Ukuran melebihi $maxMb MB" -ForegroundColor Red; exit 2 }
