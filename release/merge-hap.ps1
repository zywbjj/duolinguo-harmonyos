$ErrorActionPreference = 'Stop'
$expected = '5effb07c09c56b576f041ac246feca169b52d596defd84d8051c2a1ea8a54d80'
$output = Join-Path $PSScriptRoot 'Duolinguo-1.0.11-unsigned.hap'
$parts = 1..5 | ForEach-Object { Join-Path $PSScriptRoot ("Duolinguo-1.0.11-unsigned.hap.part" + $_) }
foreach ($part in $parts) { if (-not (Test-Path -LiteralPath $part -PathType Leaf)) { throw "Missing part: $part" } }
if (Test-Path -LiteralPath $output) { throw "Output already exists: $output" }
$out = [System.IO.File]::Open($output, [System.IO.FileMode]::CreateNew)
try {
  foreach ($part in $parts) {
    $inputStream = [System.IO.File]::OpenRead($part)
    try { $inputStream.CopyTo($out) } finally { $inputStream.Dispose() }
  }
} finally { $out.Dispose() }
$actual = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "SHA256 mismatch. Check all parts and remove the incomplete output before retrying." }
Write-Output "Verified: $output"
