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

  $global:DshToastActivated = $false
  $global:DshToastDismissed = $false
  $helper = $job.helperPath
  $uri = ''
  if ($job.sessionId) {
    $uri = 'dsh-desktop-notify://open?session=' + [Uri]::EscapeDataString($job.sessionId) +
      '&origin=' + [Uri]::EscapeDataString($job.origin)
  }

  Register-ObjectEvent -InputObject $toast -EventName Activated -SourceIdentifier 'DshToastActivated' `
    -MessageData @{ helper = $helper; uri = $uri } -Action {
      $global:DshToastActivated = $true
      Add-Content -LiteralPath (Join-Path $env:TEMP 'dsh-desktop-notify-toast.log') `
        -Value ((Get-Date).ToString('o') + ' activated') -Encoding UTF8
      $data = $Event.MessageData
      if ($data.uri) { & $data.helper $data.uri }
    } | Out-Null

  Register-ObjectEvent -InputObject $toast -EventName Dismissed -SourceIdentifier 'DshToastDismissed' -Action {
    $global:DshToastDismissed = $true
    Add-Content -LiteralPath (Join-Path $env:TEMP 'dsh-desktop-notify-toast.log') `
      -Value ((Get-Date).ToString('o') + ' dismissed') -Encoding UTF8
  } | Out-Null

  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($job.aumid).Show($toast)
  Write-ToastLog 'shown'

  $deadline = (Get-Date).AddMinutes(15)
  while (-not $global:DshToastActivated -and -not $global:DshToastDismissed -and (Get-Date) -lt $deadline) {
    Wait-Event -Timeout 1 | Out-Null
  }
  Write-ToastLog ('exit activated=' + $global:DshToastActivated + ' dismissed=' + $global:DshToastDismissed)
  Unregister-Event -SourceIdentifier 'DshToastActivated'
  Unregister-Event -SourceIdentifier 'DshToastDismissed'
} catch {
  Write-ToastLog ('error: ' + $_.Exception.Message)
} finally {
  Remove-Item -LiteralPath $JobFile -Force
}
