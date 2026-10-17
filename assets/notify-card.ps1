param([string]$JobFile)

$ErrorActionPreference = 'SilentlyContinue'
$logFile = Join-Path $env:TEMP 'dsh-desktop-notify-card.log'

function Write-CardLog([string]$Message) {
  try {
    Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('o') + ' ' + $Message) -Encoding UTF8
  } catch {}
}

try {
  if (-not $JobFile -or -not (Test-Path -LiteralPath $JobFile)) { exit 0 }
  $job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $job -or -not $job.title) { exit 0 }

  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase

  $title = [System.Security.SecurityElement]::Escape([string]$job.title)
  $body = [System.Security.SecurityElement]::Escape([string]$job.body)
  $appName = [System.Security.SecurityElement]::Escape([string]$job.appName)
  $icon = [System.Security.SecurityElement]::Escape([string]$job.iconPng)
  $hint = if ($job.sessionId) { '点击回到对话' } else { '' }

  $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ShowActivated="False"
        ResizeMode="NoResize" Width="420" Height="130">
  <Border Name="CardBorder" Background="#FF202020" CornerRadius="10" Padding="14" Cursor="Hand">
    <StackPanel Orientation="Horizontal">
      <Image Source="$icon" Width="48" Height="48" VerticalAlignment="Top"/>
      <StackPanel Margin="12,0,0,0">
        <TextBlock Text="$appName" Foreground="#FFA0A0A0" FontSize="11"/>
        <TextBlock Text="$title" Foreground="White" FontSize="15" FontWeight="Bold" TextWrapping="Wrap"/>
        <TextBlock Text="$body" Foreground="#FFD0D0D0" FontSize="12" TextWrapping="Wrap" Margin="0,3,0,0"/>
        <TextBlock Text="$hint" Foreground="#FF7FB2FF" FontSize="11" Margin="0,5,0,0"/>
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
"@

  $window = [System.Windows.Markup.XamlReader]::Parse($xaml)
  $work = [System.Windows.SystemParameters]::WorkArea
  $window.Left = $work.Right - $window.Width - 20
  $window.Top = $work.Bottom - $window.Height - 20

  $script:cardWindow = $window
  $script:cardJob = $job
  $script:cardUri = ''
  if ($job.sessionId) {
    $script:cardUri = 'dsh-desktop-notify://open?session=' + [Uri]::EscapeDataString($job.sessionId) +
      '&origin=' + [Uri]::EscapeDataString($job.origin)
  }

  $border = $window.FindName('CardBorder')
  $border.Add_MouseLeftButtonUp({
    try {
      if ($script:cardUri) {
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', $script:cardJob.helperPath, $script:cardUri
        )
      }
      Write-CardLog 'clicked'
    } catch {
      Write-CardLog ('click error: ' + $_.Exception.Message)
    }
    $script:cardWindow.Close()
  })

  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds(20)
  $timer.Add_Tick({
    $script:cardWindow.Close()
  })
  $timer.Start()

  Write-CardLog 'shown'
  $window.ShowDialog() | Out-Null
  Write-CardLog 'closed'
} catch {
  Write-CardLog ('error: ' + $_.Exception.Message)
} finally {
  Remove-Item -LiteralPath $JobFile -Force
}
