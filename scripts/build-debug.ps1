param(
  [Parameter(Mandatory = $true)]
  [string]$DevEcoHome,
  [string]$CacheRoot
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $CacheRoot) {
  $CacheRoot = Join-Path $projectRoot '.local-build'
}
$studioHome = (Resolve-Path -LiteralPath $DevEcoHome).Path
$env:PATH = (Join-Path $studioHome 'tools\node') + ';' +
  (Join-Path $studioHome 'tools\ohpm\bin') + ';' + $env:PATH
$env:JAVA_HOME = Join-Path $studioHome 'jbr'
$env:DEVECO_SDK_HOME = Join-Path $studioHome 'sdk'
$env:HVIGOR_USER_HOME = Join-Path $CacheRoot 'hvigor-cache'
$env:TEMP = Join-Path $CacheRoot 'tmp'
$env:TMP = $env:TEMP
foreach ($directory in @($env:HVIGOR_USER_HOME, $env:TEMP)) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
Push-Location $projectRoot
try {
  & (Join-Path $studioHome 'tools\node\node.exe') `
    (Join-Path $studioHome 'tools\hvigor\bin\hvigorw.js') `
    --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "Build failed: $LASTEXITCODE" }
} finally {
  Pop-Location
}
