# One-off asset preparation: download the latin woff2 subset of each design
# font into public/fonts and generate src/styles/fonts.css. The result is
# committed, so this script is not part of the build. Google serves one
# variable file per family, so each family is stored once and referenced by
# every weight.
# Raricy Numeric (public/fonts/raricy-numeric) is NOT fetched here: it is a
# local numeric derivative of JetBrains Mono, committed with its OFL text, and
# the script leaves those faces alone (see the note in the generated header).
$ErrorActionPreference = 'Stop'
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
$url = 'https://fonts.googleapis.com/css2?family=Kumbh+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap'
$css = (Invoke-WebRequest -Uri $url -Headers @{ 'User-Agent' = $ua } -UseBasicParsing -TimeoutSec 60).Content

$root = Split-Path -Parent $PSScriptRoot
$fontDir = Join-Path $root 'public\fonts'
New-Item -ItemType Directory -Force -Path $fontDir | Out-Null

$desired = @{
  'Kumbh Sans' = @(400, 500, 600, 700)
  'JetBrains Mono' = @(400, 600)
}

$pattern = '(?s)/\*\s*(?<subset>[a-z0-9-]+)\s*\*/\s*@font-face\s*\{(?<body>.*?)\}'
$blocks = [regex]::Matches($css, $pattern)
$sources = @{}
foreach ($m in $blocks) {
  if ($m.Groups['subset'].Value -ne 'latin') { continue }
  $body = $m.Groups['body'].Value
  $family = [regex]::Match($body, "font-family:\s*'([^']+)'").Groups[1].Value
  if (-not $desired.ContainsKey($family)) { continue }
  $sources[$family] = @{
    url = [regex]::Match($body, 'url\((https://[^)]+\.woff2)\)').Groups[1].Value
    range = [regex]::Match($body, 'unicode-range:\s*([^;]+);').Groups[1].Value
  }
}

$faces = New-Object System.Collections.Generic.List[string]
foreach ($family in $desired.Keys) {
  $src = $sources[$family]
  if ($null -eq $src) { throw "no latin source for $family" }
  $slug = ($family.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
  $file = "$slug-latin.woff2"
  Invoke-WebRequest -Uri $src.url -Headers @{ 'User-Agent' = $ua } -OutFile (Join-Path $fontDir $file) -UseBasicParsing -TimeoutSec 60
  Write-Host "  $file ($((Get-Item (Join-Path $fontDir $file)).Length) bytes)"
  foreach ($weight in $desired[$family]) {
    $faces.Add(@"
@font-face {
  font-family: '$family';
  font-style: normal;
  font-weight: $weight;
  font-display: swap;
  src: url('/fonts/$file') format('woff2');
  unicode-range: $($src.range);
}
"@)
  }
}

$header = @'
/* Generated from the Google Fonts API: the latin subset of each design font.
   Re-run `frontend/web/scripts/fetch-fonts.ps1` to refresh. */
'@
$out = Join-Path $root 'src\styles\fonts.css'
Set-Content -Path $out -Value ($header + "`n" + ($faces -join "`n")) -Encoding utf8
Write-Host "wrote $out"
