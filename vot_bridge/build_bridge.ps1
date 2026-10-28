#!/usr/bin/env pwsh
# Rebuild the VOT bridge dex, inject into the clean base APK, align, sign, install.
# Default device is the test box YNDX-00091. SberBox (192.168.1.198) must be passed
# explicitly on purpose: it is the user's daily-driver TV and is off-limits unless asked.
param([switch]$NoInstall, [string]$Device = "192.168.1.100:5555")
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
javac --release 8 -classpath $jar -d vot_bridge\classes vot_bridge\java\vot\*.java
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "==> d8"
$cls = (Get-ChildItem vot_bridge\classes -Recurse -Filter *.class).FullName
java -cp $d8 com.android.tools.r8.D8 --release --lib $jar --min-api 24 --output vot_bridge\dex $cls
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }
Move-Item -Force vot_bridge\dex\classes.dex vot_bridge\classes4.dex

Write-Host "==> overlay bundle"
# The overlay must ship inside the APK: ui + main + net glued the same way the
# dev server does it, so a fresh install talks to nothing but Yandex.
$ovParts = @("vot_ui.js", "vot.js", "vot_net.js")
$ovText = ""
foreach ($p in $ovParts) {
    $full = Join-Path $root "dev_server\$p"
    if (Test-Path $full) {
        $ovText += [IO.File]::ReadAllText($full, [Text.Encoding]::UTF8) + "`n;`n"
    } elseif ($p -eq "vot.js") {
        throw "missing $full"
    }
}
[IO.File]::WriteAllText("$root\vot_bridge\assets\vot.js", $ovText, (New-Object Text.UTF8Encoding($false)))
Write-Host ("    assets/vot.js {0} bytes" -f ([Text.Encoding]::UTF8.GetByteCount($ovText)))

Write-Host "==> inject + align + sign"
python -c "import zipfile,shutil; shutil.copy('tt203_bridge_unsigned.apk','tt203_bridge_injected.apk'); z=zipfile.ZipFile('tt203_bridge_injected.apk','a',zipfile.ZIP_DEFLATED); z.write('vot_bridge/classes4.dex','classes4.dex'); z.write('vot_bridge/assets/po_token.html','assets/po_token.html'); z.write('vot_bridge/assets/vot.js','assets/vot.js'); z.close(); print('injected')"
if ($LASTEXITCODE -ne 0) { throw "inject failed" }
& "$bt\zipalign.exe" -f 4 tt203_bridge_injected.apk tt203_bridge_aligned.apk
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }
& "$bt\apksigner.bat" sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android --out tt203_bridge.apk tt203_bridge_aligned.apk
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }
& "$bt\apksigner.bat" verify tt203_bridge.apk

if (-not $NoInstall) {
    Write-Host "==> install"
    adb -s $Device install -r tt203_bridge.apk
}
Write-Host "DONE: $root\tt203_bridge.apk"
