#!/usr/bin/env pwsh
# Dev loop helper: rebuild patched APK from apk_203, align, sign, verify.
# Usage:  .\dev_build.ps1 [-Url "http://192.168.1.186:8013/vot.js?v="] [-Install]
#   -Url         URL patched into libchrobalt.so (<= len of original npm URL)
#   -Install     also `adb install -r` to the connected device
param(
    [string]$Url = "",
    [switch]$Install
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if ($Url) { $env:VOT_SCRIPT_URL = $Url } else { Remove-Item Env:VOT_SCRIPT_URL -ErrorAction SilentlyContinue }

Write-Host "==> patch URL" -ForegroundColor Cyan
python patch_tizentube_userscript_url.py apk_203
if ($LASTEXITCODE -ne 0) { throw "patch failed" }

Write-Host "==> apktool b" -ForegroundColor Cyan
java -jar apktool.jar b apk_203 -o tizentube_diag_unsigned.apk
if ($LASTEXITCODE -ne 0) { throw "apktool b failed" }

Write-Host "==> zipalign" -ForegroundColor Cyan
& "$env:ANDROID_HOME\build-tools\33.0.2\zipalign.exe" -f 4 tizentube_diag_unsigned.apk tizentube_diag_aligned.apk
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "==> apksigner" -ForegroundColor Cyan
& "$env:ANDROID_HOME\build-tools\33.0.2\apksigner.bat" sign `
    --ks debug.keystore --ks-pass pass:android --key-pass pass:android `
    --out tizentube_diag.apk tizentube_diag_aligned.apk
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

Write-Host "==> verify" -ForegroundColor Cyan
& "$env:ANDROID_HOME\build-tools\33.0.2\apksigner.bat" verify --print-certs tizentube_diag.apk
Get-Item tizentube_diag.apk | Select-Object Name, Length, LastWriteTime

if ($Install) {
    Write-Host "==> adb install" -ForegroundColor Cyan
    adb -s 192.168.1.100:5555 install -r tizentube_diag.apk
}
