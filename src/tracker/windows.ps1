# Windows: 따라붙을 앱(Claude) 창의 자리와 포커스를 한 줄 JSON으로 계속 알려 준다.
param([int]$OwnPid = 0, [string]$Target = 'claude', [string]$Exact = 'false', [string]$Compatible = 'true', [string]$ShowWhen = 'focused', [switch]$List)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClauWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
}
'@

# 화면 배율과 상관없이 실제 픽셀 좌표를 받는다. 앱이 자기 단위로 바꾼다.
[void][ClauWin]::SetProcessDPIAware()

if ($List) {
  $apps = @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -ne $OwnPid -and $_.MainWindowHandle -ne 0 -and [ClauWin]::IsWindowVisible($_.MainWindowHandle) } |
    ForEach-Object { @{ id = $_.ProcessName.ToLowerInvariant(); label = $_.ProcessName; pid = $_.Id } })
  ConvertTo-Json -InputObject $apps -Compress
  exit
}

function Test-Target([string]$name) {
  if ($Compatible -ne 'true') { return $false }
  if ($Exact -eq 'true') { return $name.ToLowerInvariant() -eq $Target.ToLowerInvariant() }
  return $name.ToLowerInvariant().Contains($Target.ToLowerInvariant())
}

$names = @{}
function Get-Name([uint32]$procId) {
  if (-not $names.ContainsKey($procId)) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $names[$procId] = if ($p) { $p.ProcessName.ToLower() } else { '' }
  }
  return $names[$procId]
}

function Find-Target {
  $p = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Id -ne $OwnPid -and $_.MainWindowHandle -ne 0 -and (Test-Target $_.ProcessName) } |
    Select-Object -First 1
  if ($p) { return $p.MainWindowHandle }
  return [IntPtr]::Zero
}

$targetWindow = [IntPtr]::Zero
$last = ''
$tick = 0
$cachedWindow = [IntPtr]::Zero
$cachedRect = $null
$lastState = ''
while ($true) {
  $fg = [ClauWin]::GetForegroundWindow()
  $fgPid = 0
  [void][ClauWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $active = 'other'
  if ($fgPid -eq $OwnPid) { $active = 'ours' }
  elseif ($fgPid -ne 0 -and (Test-Target (Get-Name $fgPid))) { $active = 'target'; $targetWindow = $fg }

  $alive = $targetWindow -ne [IntPtr]::Zero -and [ClauWin]::IsWindow($targetWindow) -and [ClauWin]::IsWindowVisible($targetWindow)
  if (-not $alive) {
    $targetWindow = [IntPtr]::Zero
    # 프로세스 목록을 훑는 일은 무거워서 2초에 한 번만 한다.
    if ($tick % 16 -eq 0) { $names.Clear(); $targetWindow = Find-Target }
  }

  $minimized = $false
  if ($targetWindow -ne $cachedWindow) { $cachedRect = $null; $cachedWindow = $targetWindow }
  if ($targetWindow -ne [IntPtr]::Zero) {
    $minimized = [ClauWin]::IsIconic($targetWindow)
    $visible = $ShowWhen -eq 'open' -or $active -eq 'target' -or $active -eq 'ours'
    # Hidden pets do not need DWM geometry. Keep the cheap focus check at the
    # original 120ms rate so returning to the selected app remains immediate.
    if (-not $cachedRect -or ($visible -and -not $minimized)) {
      $r = New-Object ClauWin+RECT
      if ([ClauWin]::DwmGetWindowAttribute($targetWindow, 9, [ref]$r, 16) -ne 0) { [void][ClauWin]::GetWindowRect($targetWindow, [ref]$r) }
      $cachedRect = @($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
    }
  }
  # ConvertTo-Json is relatively expensive in PowerShell. Only serialize actual
  # native state changes rather than every timer wakeup.
  $state = "$targetWindow/$active/$minimized/$($cachedRect -join ',')"
  if ($state -ne $lastState) {
    $lastState = $state
    $msg = @{ found = $targetWindow -ne [IntPtr]::Zero; active = $active }
    if ($msg.found) { $msg.rect = $cachedRect; $msg.minimized = $minimized }
    $text = $msg | ConvertTo-Json -Compress
    if ($text -ne $last) { $last = $text; [Console]::Out.WriteLine($text); [Console]::Out.Flush() }
  }
  $tick++
  Start-Sleep -Milliseconds 120
}
