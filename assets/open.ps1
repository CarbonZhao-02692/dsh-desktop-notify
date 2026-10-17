param([string]$Uri)

$ErrorActionPreference = 'SilentlyContinue'
$logFile = Join-Path $env:TEMP 'dsh-desktop-notify-helper.log'

function Write-Log([string]$Message) {
  try {
    Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('o') + ' ' + $Message) -Encoding UTF8
  } catch {}
}

function Unescape([string]$value) {
  try { return [Uri]::UnescapeDataString($value) } catch { return $value }
}

# 把浏览器里标题包含 $Needle 的标签页切到前台（Edge / Chrome 通用）。
function Focus-BrowserTab([string]$Needle) {
  if ([string]::IsNullOrWhiteSpace($Needle)) { return $false }
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $procs = Get-Process msedge, chrome -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -match 'DeepSeek Harness' }
    if (-not $procs) {
      $procs = Get-Process msedge, chrome -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle }
    }
    foreach ($proc in $procs) {
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if (-not $win) { continue }
      $tabCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem)
      $tabs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
      foreach ($tab in $tabs) {
        $name = $tab.Current.Name
        if (-not $name) { continue }
        $match = $name.IndexOf($Needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if (-not $match -and $Needle.Length -gt 10) {
          $short = $Needle.Substring(0, 10)
          $match = $name.IndexOf($short, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        if ($match) {
          try {
            $sel = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $sel.Select()
            $tab.SetFocus()
            Write-Log "tab selected: $name"
            return $true
          } catch {
            Write-Log "tab select failed: $name :: $($_.Exception.Message)"
          }
        }
      }
    }
  } catch {
    Write-Log "focus error: $($_.Exception.Message)"
  }
  return $false
}

# 把运行 DSH 的浏览器窗口带到前台；后台窗口里直接选标签页不会真正切过去，
# 所以必须先激活窗口，再选标签页。
function Activate-Browser {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $browser = Get-Process msedge, chrome -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -match 'DeepSeek Harness' } |
      Select-Object -First 1
    if (-not $browser) {
      $browser = Get-Process msedge, chrome -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle } | Select-Object -First 1
    }
    if ($browser) {
      try {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DshWin32Focus {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
        $hwnd = $browser.MainWindowHandle
        $foreground = $false
        if ($hwnd -ne 0) {
          $minimized = [DshWin32Focus]::IsIconic($hwnd)
          $maximized = [DshWin32Focus]::IsZoomed($hwnd)
          if ($minimized) {
            [DshWin32Focus]::ShowWindow($hwnd, 9) | Out-Null
          }
          [DshWin32Focus]::BringWindowToTop($hwnd) | Out-Null
          $foreground = [DshWin32Focus]::SetForegroundWindow($hwnd)
          if (-not $foreground) {
            [DshWin32Focus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
            [DshWin32Focus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
            $foreground = [DshWin32Focus]::SetForegroundWindow($hwnd)
          }
          Write-Log "activate hwnd=$hwnd minimized=$minimized maximized=$maximized foreground=$foreground"
        }
      } catch {
        Write-Log "Win32 activate error: $($_.Exception.Message)"
      }
      $activated = $foreground
      if (-not $activated) {
        $activated = $shell.AppActivate($browser.Id)
        Write-Log "AppActivate id=$($browser.Id) title=$($browser.MainWindowTitle) result=$activated"
      } else {
        Write-Log 'already foreground; skip AppActivate (preserve maximized state)'
      }
      return $activated
    }
    Write-Log 'AppActivate: no browser window found'
  } catch {
    Write-Log "AppActivate error: $($_.Exception.Message)"
  }
  return $false
}

# 1) 把会话 id 回传给正在运行的 DSH host。
try {
  Write-Log "start uri=$Uri"
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
    Write-Log "response live=$($resp.livePages) targetTitle=$($resp.targetTitle) sessionTitle=$($resp.sessionTitle) fallback=$([bool]$resp.fallbackUrl)"
    # 没有任何已打开页面时，host 返回一个带密钥的引导 URL；由 helper 打开新页。
    if ($resp -and $resp.fallbackUrl) {
      Start-Process $resp.fallbackUrl
    }

    # 浏览器可能正停在别的标签页：先把浏览器窗口带到前台，再切目标 DSH 标签页。
    Activate-Browser | Out-Null
    Start-Sleep -Milliseconds 300
    $focusedTab = Focus-BrowserTab $resp.targetTitle
    Write-Log "focus targetTitle result=$focusedTab"
    if (-not $focusedTab) {
      Start-Sleep -Milliseconds 1200
      $focusedTab = Focus-BrowserTab $resp.sessionTitle
      Write-Log "focus sessionTitle result=$focusedTab"
    }
    if (-not $focusedTab) {
      Focus-BrowserTab 'DeepSeek Harness' | Out-Null
      Write-Log 'focus fallback DeepSeek Harness'
    }
    Activate-Browser | Out-Null
  }
} catch {}
