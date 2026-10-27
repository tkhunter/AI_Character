# Downloads hexgrad/Kokoro-82M-v1.1-zh (config, weights, voices) into tts\models\Kokoro-82M-v1.1-zh.
# Some Windows setups cannot resolve Hugging Face's CDN hosts through the system resolver even though
# DNS answers them; each CDN host is therefore resolved with Resolve-DnsName and pinned for curl
# (--resolve). TLS is still verified against the real host name.
$ErrorActionPreference = 'Stop'
$repo = 'hexgrad/Kokoro-82M-v1.1-zh'
$target = Join-Path $PSScriptRoot 'models\Kokoro-82M-v1.1-zh'
New-Item -ItemType Directory -Force (Join-Path $target 'voices') | Out-Null

$info = Invoke-RestMethod "https://huggingface.co/api/models/$repo"
$files = $info.siblings.rfilename | Where-Object { $_ -eq 'config.json' -or $_ -like '*.pth' -or ($_ -like 'voices/*.pt') }
Write-Host "Revision $($info.sha): $($files.Count) files"

$pinned = @{}
function Pin([string]$url) {
  $hostName = ([uri]$url).Host
  if (-not $pinned.ContainsKey($hostName)) {
    $ip = (Resolve-DnsName $hostName -Type A | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
    if (-not $ip) { throw "Cannot resolve $hostName" }
    $pinned[$hostName] = "$($hostName):443:$ip"
  }
  return $pinned[$hostName]
}

$done = 0
foreach ($file in $files) {
  $out = Join-Path $target ($file -replace '/', '\')
  if ((Test-Path $out) -and (Get-Item $out).Length -gt 0) { $done++; continue }
  $url = "https://huggingface.co/$repo/resolve/$($info.sha)/$file"
  # Follow redirects one hop at a time so every new CDN host gets pinned.
  for ($hop = 0; $hop -lt 6; $hop++) {
    $resolveArgs = @(); if (([uri]$url).Host -ne 'huggingface.co') { $resolveArgs = @('--resolve', (Pin $url)) }
    $headers = & curl.exe -sS -I -m 60 @resolveArgs $url
    $location = ($headers | Where-Object { $_ -match '^location:' } | Select-Object -Last 1) -replace '^location:\s*', ''
    if (-not $location) { break }
    $url = if ($location.StartsWith('/')) { "https://$(([uri]$url).Host)$($location.Trim())" } else { $location.Trim() }
  }
  $resolveArgs = @(); if (([uri]$url).Host -ne 'huggingface.co') { $resolveArgs = @('--resolve', (Pin $url)) }
  & curl.exe -sS -f -m 900 @resolveArgs -o "$out.partial" $url
  if ($LASTEXITCODE -ne 0) { Remove-Item -ErrorAction SilentlyContinue "$out.partial"; throw "Download failed: $file" }
  Move-Item -Force "$out.partial" $out
  $done++
  if ($file -like '*.pth') { Write-Host ("  {0} ({1:N0} MB)" -f $file, ((Get-Item $out).Length / 1MB)) }
}
Write-Host "Ready: $done/$($files.Count) files in $target"
