# Builds the portable distribution: the app plus the fixed WebView2 runtime it needs, zipped.
#
# Most Windows installs already have WebView2 and run the ordinary 10 MB build fine. This package is
# for the ones that don't -- Server, LTSC, N editions, debloated images with Edge stripped out --
# where a plain exe fails with "Could not find the WebView2 Runtime" before drawing anything.
#
# The difference is one config key, so it lives in tauri.portable.conf.json and is merged in only
# here. The everyday build stays small and never carries the runtime, and there is no flag to
# remember to flip: what pnpm dev and pnpm tauri build produce is always the ordinary kind.
#
#   nvm use 22.13.0
#   pnpm package:portable

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$runtime = Join-Path $root "src-tauri\wv2"
if (-not (Test-Path (Join-Path $runtime "msedgewebview2.exe"))) {
    throw "src-tauri\wv2 is missing or incomplete. It is gitignored because of its size -- see the README for where to download it."
}
if (Get-Process | Where-Object { $_.ProcessName -like "MC3*" -or $_.ProcessName -eq "app" }) {
    throw "The app is running. Close it first -- the build cannot overwrite a locked exe, and the check at the end needs to launch its own copy."
}

$version = (Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
# The folder inside the zip is deliberately terse. Windows caps a path at 260 characters, the
# runtime spends 99 of them on its own nesting, and every character here comes out of what is left
# for wherever the recipient extracts it. The app keeps its full name -- this is only the container.
$folder = "MC3ModTool"
$out = Join-Path $root "dist-portable"
$stage = Join-Path $out $folder

Write-Host "Building with the portable config..." -ForegroundColor Cyan
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
pnpm tauri build --no-bundle --config src-tauri/tauri.portable.conf.json
if ($LASTEXITCODE -ne 0) { throw "The Tauri build failed." }

$exe = Join-Path $root "src-tauri\target\release\MC3 Modding Toolkit.exe"
if (-not (Test-Path $exe)) { throw "MC3 Modding Toolkit.exe was not produced." }

Write-Host "Staging..." -ForegroundColor Cyan
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item $exe (Join-Path $stage "MC3 Modding Toolkit.exe")
Copy-Item $runtime (Join-Path $stage "wv2") -Recurse

# Prove the package works before handing it over. Nothing here is exercised day to day -- the
# ordinary build is what gets tested while developing -- so without this the first time anyone finds
# out the portable build is broken is when someone downloads it.
Write-Host "Checking the packaged app actually runs on its own runtime..." -ForegroundColor Cyan
$staged = Join-Path $stage "MC3 Modding Toolkit.exe"
$proc = Start-Process $staged -PassThru
try {
    Start-Sleep -Seconds 12
    $proc.Refresh()
    $title = $proc.MainWindowTitle
    $local = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
        Where-Object { $_.ExecutablePath -like (Join-Path $stage "wv2*") }).Count
} finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
# An empty title means the window opened but the webview never initialised: with fixedRuntime set
# there is no falling back to a system install, so a missing or unreachable wv2 leaves a blank frame.
if (-not $title) { throw "The packaged app opened no titled window -- the webview did not start." }
if ($local -eq 0) { throw "The packaged app did not load the bundled runtime in wv2." }
Write-Host "  window '$title', $local processes from the bundled runtime" -ForegroundColor Green

$zip = Join-Path $out "MC3 Modding Toolkit $version (portable).zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host "Compressing (a few minutes -- the runtime is ~800 MB)..." -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)

$prefix = $stage.Length + 1
$deepest = (Get-ChildItem $stage -Recurse -File | ForEach-Object { $_.FullName.Substring($prefix).Length } | Measure-Object -Maximum).Maximum
$spend = $folder.Length + 1 + $deepest
$zipMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
$stageMb = [math]::Round((Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)

Write-Host ""
Write-Host "Folder:  $stage  ($stageMb MB)" -ForegroundColor Green
Write-Host "Zip:     $zip  ($zipMb MB)" -ForegroundColor Green
Write-Host "Uses $spend of the 260-character path limit, so it can be extracted into a folder path" -ForegroundColor Green
Write-Host "of up to $(260 - $spend) characters. Deeper than that and Windows cannot reach the runtime." -ForegroundColor Green
