param(
    [switch]$Emulator,
    [switch]$Install,
    [switch]$Bump
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$gradlePath = Join-Path $root 'android\app\build.gradle'
$gradle = [IO.File]::ReadAllText($gradlePath)
$code = [int]([regex]::Match($gradle, 'versionCode\s*=\s*(\d+)').Groups[1].Value)
if ($Bump -and -not $Emulator) {
    $code++
    $gradle = $gradle -replace 'versionCode\s*=\s*\d+', "versionCode = $code"
    $gradle = $gradle -replace 'versionName\s*=\s*"[^"]+"', "versionName = `"0.1.$code`""
    [IO.File]::WriteAllText($gradlePath, $gradle)
    $cargoApp = Join-Path $root 'seru24-app\Cargo.toml'
    $cargoTxt = [IO.File]::ReadAllText($cargoApp) -replace '(?m)^version\s*=\s*"[^"]+"', "version = `"0.1.$code`""
    [IO.File]::WriteAllText($cargoApp, $cargoTxt)
    $acctSlint = Join-Path $root 'seru24-app\ui\account_screen.slint'
    $acctTxt = [IO.File]::ReadAllText($acctSlint) -replace 'app-version:\s*"[^"]+"', "app-version: `"0.1.$code`""
    [IO.File]::WriteAllText($acctSlint, $acctTxt)
    Write-Output "Versi: 0.1.$code (build $code)"
}

if ($Emulator) {
    $abi = 'x86_64'
    $ndkTriple = 'x86_64_linux_android'
    $outApk = Join-Path $root "seru24-rust-$code-emulator.apk"
    $signingProp = '-PseruSigning=debug'
} else {
    $abi = 'arm64-v8a'
    $ndkTriple = 'aarch64_linux_android'
    $outApk = Join-Path $root "seru24-rust-$code.apk"
    $signingProp = '-PseruSigning=release'
}

if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
if (-not $env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME }
if (-not $env:ANDROID_NDK_HOME) {
    $ndkDir = Get-ChildItem "$env:ANDROID_HOME\ndk" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
    if ($ndkDir) { $env:ANDROID_NDK_HOME = $ndkDir }
}
if (Test-Path 'C:\Program Files\Java\jdk-17') {
    $env:JAVA_HOME = 'C:\Program Files\Java\jdk-17'
}
if ($env:JAVA_HOME) {
    $env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
}
$androidJar36 = Join-Path $env:ANDROID_HOME 'platforms\android-36\android.jar'
if (Test-Path $androidJar36) {
    $env:ANDROID_JAR = $androidJar36
    $env:ANDROID_PLATFORM = 'android-36'
}

# Set toolchain C/C++ NDK eksplisit untuk crate C seperti ring & libsqlite3-sys.
if ($env:ANDROID_NDK_HOME) {
    $llvmBin = Join-Path $env:ANDROID_NDK_HOME 'toolchains\llvm\prebuilt\windows-x86_64\bin'
    if (Test-Path $llvmBin) {
        $clangPrefix = if ($Emulator) { 'x86_64-linux-android29' } else { 'aarch64-linux-android29' }
        Set-Item "Env:CC_$ndkTriple" (Join-Path $llvmBin "$clangPrefix-clang.cmd")
        Set-Item "Env:CXX_$ndkTriple" (Join-Path $llvmBin "$clangPrefix-clang++.cmd")
        Set-Item "Env:AR_$ndkTriple" (Join-Path $llvmBin 'llvm-ar.exe')
        Set-Item "Env:CFLAGS_$ndkTriple" '-Os -g0 -fno-unwind-tables -fno-asynchronous-unwind-tables -ffunction-sections -fdata-sections'
        Set-Item "Env:CXXFLAGS_$ndkTriple" '-Os -g0 -fno-unwind-tables -fno-asynchronous-unwind-tables -ffunction-sections -fdata-sections'
    }
}

$jniLibs = Join-Path $root 'android\app\src\main\jniLibs'
if (Test-Path $jniLibs) {
    Remove-Item -Recurse -Force $jniLibs
}
New-Item -ItemType Directory -Force -Path $jniLibs | Out-Null

$t0 = Get-Date
& cargo ndk -P 29 -t $abi -o $jniLibs build -p seru24-app --release
if ($LASTEXITCODE -ne 0) {
    Write-Error 'cargo ndk gagal.'
    exit 1
}

Push-Location (Join-Path $root 'android')
try {
    & .\gradlew.bat assembleRelease "-PseruAbi=$abi" $signingProp --no-daemon
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'Gradle assembleRelease gagal.'
        exit 1
    }
} finally {
    Pop-Location
}

$gradleApk = Get-ChildItem (Join-Path $root 'android\app\build\outputs\apk\release\*.apk') | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $gradleApk) {
    Write-Error 'APK hasil Gradle tidak ditemukan.'
    exit 1
}
Copy-Item $gradleApk.FullName $outApk -Force

$mb = [Math]::Round((Get-Item $outApk).Length / 1MB, 2)
$sec = [Math]::Round(((Get-Date) - $t0).TotalSeconds)
Write-Output ("APK: $(Split-Path -Leaf $outApk) ($mb MB, $abi)")
Write-Output ("Durasi: $sec detik")

$maxMb = 20
if ($mb -gt $maxMb) {
    Write-Warning "Ukuran APK ($mb MB) melebihi batas target $maxMb MB."
}

if ($Install) {
    $adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
    & $adb install -r $outApk
}
