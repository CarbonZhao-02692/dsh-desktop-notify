param([string]$Uri)

$ErrorActionPreference = 'SilentlyContinue'

function Unescape([string]$value) {
  try { return [Uri]::UnescapeDataString($value) } catch { return $value }
}

# 1) 把会话 id 回传给正在运行的 DSH host。
try {
  if (-not $Uri) { exit 0 }
  $u = [Uri]$Uri
  $query = $u.Query
  if ($query.StartsWith('?')) { $query = $query.Substring(1) }
  $parts = @{}
  foreach ($pair in $query.Split('&')) {
    if (-not $pair) { continue }
    $kv = $pair -split '=', 2
    $key = Unescape $kv[0]
    $value = if ($kv.Length -gt 1) { Unescape $kv[1] } else { '' }
    $parts[$key] = $value
  }
  $session = $parts['session']
  $origin = $parts['origin']
  if (-not $origin) { $origin = 'http://127.0.0.1:3080' }
  if ($session) {
    $body = @{ sessionId = $session; forceFallback = ($parts['fallback'] -eq '1') } | ConvertTo-Json -Compress
    $resp = Invoke-RestMethod -Method POST -Uri ($origin.TrimEnd('/') + '/dsh-desktop-notify/activate') `
      -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 5
    # 没有任何已打开页面时，host 返回一个带密钥的引导 URL；由 helper 打开新页。
    if ($resp -and $resp.fallbackUrl) {
      Start-Process $resp.fallbackUrl
    }
  }
} catch {}

# 2) 尽力把已在运行的浏览器窗口带到前台；页面侧随后会切换到目标会话。
try {
  $shell = New-Object -ComObject WScript.Shell
  $browser = Get-Process msedge, chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -match 'DeepSeek Harness' } |
    Select-Object -First 1
  if (-not $browser) {
    $browser = Get-Process msedge, chrome -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  }
  if ($browser) { $shell.AppActivate($browser.Id) | Out-Null }
} catch {}
