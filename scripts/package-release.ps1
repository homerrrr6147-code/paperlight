param([string]$GitDirectory = '')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$gitArgs = @()
if ($GitDirectory) { $gitArgs = @("--git-dir=$GitDirectory", "--work-tree=$PWD") }
$status = & git @gitArgs status --porcelain
if ($LASTEXITCODE -ne 0 -or $status) { throw 'Commit reviewed source changes before packaging.' }
$conf = Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json
if ($conf.version -ne $version) { throw 'Version mismatch.' }
$exe = 'src-tauri/target/release/paperlight.exe'
$setup = "src-tauri/target/release/bundle/nsis/Paperlight_${version}_x64-setup.exe"
foreach ($file in @($exe, $setup, 'THIRD_PARTY_NOTICES.txt', 'LICENSE')) {
  if (!(Test-Path -LiteralPath $file)) { throw "Missing $file" }
}
$output = "outputs/release-$version"
if (Test-Path -LiteralPath $output) { throw "Output already exists: $output" }
New-Item -ItemType Directory -Path $output | Out-Null
$stage = Join-Path 'work' ("portable-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'Paperlight.exe')
Copy-Item -LiteralPath 'LICENSE','README.md','THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.txt' -Destination $stage
Compress-Archive -Path "$stage/*" -DestinationPath "$output/Paperlight-$version-windows-x64-portable.zip"
Copy-Item -LiteralPath $setup -Destination "$output/Paperlight-$version-windows-x64-setup.exe"
& git @gitArgs archive --format=zip "--output=$output/Paperlight-$version-source.zip" HEAD
if ($LASTEXITCODE -ne 0) { throw 'Source export failed.' }
Copy-Item -LiteralPath 'THIRD_PARTY_NOTICES.txt' -Destination $output
Copy-Item -LiteralPath 'CHANGELOG.md' -Destination "$output/RELEASE_NOTES.md"
$checksums = Get-ChildItem -LiteralPath $output -File | Sort-Object Name | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $($_.Name)"
}
$checksums | Set-Content -LiteralPath "$output/SHA256SUMS.txt" -Encoding ascii
Write-Output "Release ready: $output"
