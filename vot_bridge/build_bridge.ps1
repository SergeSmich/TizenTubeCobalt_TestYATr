#!/usr/bin/env pwsh
# Rebuild the VOT bridge dex, inject into the clean base APK, align, sign, install.
param([switch]$NoInstall)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$jar  = "$env:ANDROID_HOME\platforms\android-34\android.jar"
$d8   = "$env:ANDROID_HOME\build-tools\33.0.2\lib\d8.jar"
$bt   = "$env:ANDROID_HOME\build-tools\33.0.2"
$base = "$root\tt203_bridge_unsigned.apk"

Remove-Item -Recurse -Force vot_bridge\classes, vot_bridge\dex -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path vot_bridge\classes, vot_bridge\dex | Out-Null

Write-Host "==> javac"
javac --release 8 -classpath $jar -d vot_bridge\classes vot_bridge\java\vot\Bridge.java
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "==> d8"
$cls = (Get-ChildItem vot_bridge\classes -Recurse -Filter *.class).FullName
java -cp $d8 com.android.tools.r8.D8 --release --lib $jar --min-api 24 --output vot_bridge\dex $cls
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }
Move-Item -Force vot_bridge\dex\classes.dex vot_bridge\classes4.dex

Write-Host "==> inject + align + sign"
python -c "import zipfile,shutil; shutil.copy('tt203_bridge_unsigned.apk','tt203_bridge_injected.apk'); z=zipfile.ZipFile('tt203_bridge_injected.apk','a',zipfile.ZIP_DEFLATED); z.write('vot_bridge/classes4.dex','classes4.dex'); z.close(); print('injected')"
if ($LASTEXITCODE -ne 0) { throw "inject failed" }
& "$bt\zipalign.exe" -f 4 tt203_bridge_injected.apk tt203_bridge_aligned.apk
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }
& "$bt\apksigner.bat" sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android --out tt203_bridge.apk tt203_bridge_aligned.apk
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }
& "$bt\apksigner.bat" verify tt203_bridge.apk

if (-not $NoInstall) {
    Write-Host "==> install"
    adb -s 192.168.1.100:5555 install -r tt203_bridge.apk
}
Write-Host "DONE: $root\tt203_bridge.apk"
