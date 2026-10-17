param([string]$JobFile)

$ErrorActionPreference = 'SilentlyContinue'
$logFile = Join-Path $env:TEMP 'dsh-desktop-notify-toast.log'

function Write-ToastLog([string]$Message) {
  try {
    Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('o') + ' ' + $Message) -Encoding UTF8
  } catch {}
}

try {
  if (-not $JobFile -or -not (Test-Path -LiteralPath $JobFile)) { exit 0 }
  $job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $job -or -not $job.xml) { exit 0 }

  try {
    $key = 'HKCU:\SOFTWARE\Classes\AppUserModelId\' + $job.aumid
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name DisplayName -Value $job.appName -PropertyType String -Force | Out-Null
    if ($job.iconUri) {
      New-ItemProperty -Path $key -Name IconUri -Value $job.iconUri -PropertyType String -Force | Out-Null
    }
  } catch {}

  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
  $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
  $doc.LoadXml($job.xml)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
  if ($job.suppressPopup) { $toast.SuppressPopup = $true }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($job.aumid).Show($toast)
  Write-ToastLog 'shown'
} catch {
  Write-ToastLog ('error: ' + $_.Exception.Message)
} finally {
  Remove-Item -LiteralPath $JobFile -Force
}
