<# : batch
@echo off
rem 클로 설치 도우미 (Windows). 이 파일 하나를 더블클릭하면 창이 열린다.
rem 아래는 PowerShell 스크립트다. cmd 는 이 줄까지만 읽고 PowerShell 에 넘긴다.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$f='%~f0'; iex ((Get-Content -LiteralPath $f -Encoding UTF8) -join [char]10)"
exit /b
#>
# ── 클로 설치 도우미 ──────────────────────────────────────────────────────
# 설치, 업데이트, 고치기(다시 설치), 삭제, 열기. 설정은 지우라고 할 때만 지운다.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.IO.Compression.FileSystem
[System.Windows.Forms.Application]::EnableVisualStyles()
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'OCGK123/clau'
$Base = "https://github.com/$Repo/releases/latest/download"
$ZipName = 'Clau-windows-x64.zip'
$Dest = Join-Path $env:LOCALAPPDATA 'Clau'
$Exe = Join-Path $Dest 'clau.exe'
$Shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Clau.lnk'
$DataDir = Join-Path $env:APPDATA 'Clau'
$Script:Latest = $null

function Get-InstalledVersion {
  $p = Join-Path $Dest 'resources\app\package.json'
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  try { return (Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { return '?' }
}
function Test-Newer([string]$a, [string]$b) {
  try { return ([version]$a) -gt ([version]$b) } catch { return $false }
}

# ── 창 ──
$font = New-Object System.Drawing.Font('Malgun Gothic', 10)
$form = New-Object System.Windows.Forms.Form
$form.Text = '클로 설치 도우미'
$form.ClientSize = New-Object System.Drawing.Size(440, 230)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.Font = $font
$form.BackColor = [System.Drawing.Color]::FromArgb(250, 245, 239)

$title = New-Object System.Windows.Forms.Label
$title.Text = '클로'
$title.Font = New-Object System.Drawing.Font('Malgun Gothic', 16, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(217, 100, 63)
$title.Location = New-Object System.Drawing.Point(20, 14)
$title.AutoSize = $true
$form.Controls.Add($title)

$info = New-Object System.Windows.Forms.Label
$info.Location = New-Object System.Drawing.Point(22, 56)
$info.Size = New-Object System.Drawing.Size(400, 44)
$form.Controls.Add($info)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(22, 104)
$bar.Size = New-Object System.Drawing.Size(396, 14)
$bar.Visible = $false
$form.Controls.Add($bar)

$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Location = New-Object System.Drawing.Point(18, 170)
$panel.Size = New-Object System.Drawing.Size(410, 44)
$panel.FlowDirection = 'LeftToRight'
$form.Controls.Add($panel)

function New-Button([string]$text, [scriptblock]$action) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.AutoSize = $true
  $b.MinimumSize = New-Object System.Drawing.Size(84, 32)
  $b.Add_Click($action)
  $panel.Controls.Add($b)
  return $b
}

function Say([string]$text) {
  $info.Text = $text
  [System.Windows.Forms.Application]::DoEvents()
}
function Set-Progress([int]$value) {
  $bar.Visible = $true
  $bar.Value = [Math]::Max(0, [Math]::Min(100, $value))
  [System.Windows.Forms.Application]::DoEvents()
}
function Set-Busy([bool]$busy) {
  foreach ($c in $panel.Controls) { $c.Enabled = -not $busy }
  $form.UseWaitCursor = $busy
  [System.Windows.Forms.Application]::DoEvents()
}

# ── 일 ──
function Get-Latest {
  if (-not $Script:Latest) {
    $Script:Latest = Invoke-RestMethod -Uri "$Base/latest.json" -UserAgent 'Clau-Installer'
  }
  return $Script:Latest
}

function Stop-Clau {
  if (Test-Path -LiteralPath $Exe) {
    try { Start-Process -FilePath $Exe -ArgumentList '--quit' -Wait } catch {}
    Start-Sleep -Milliseconds 800
  }
  Get-Process -Name 'clau' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Get-File([string]$url, [string]$file, [long]$size) {
  $req = [Net.HttpWebRequest]::Create($url)
  $req.UserAgent = 'Clau-Installer'
  $res = $req.GetResponse()
  $in = $res.GetResponseStream()
  $out = [IO.File]::Create($file)
  $buf = New-Object byte[] 262144
  $got = 0L
  try {
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
      $out.Write($buf, 0, $n)
      $got += $n
      Set-Progress ([int](85 * $got / $size))
    }
  } finally { $out.Close(); $in.Close(); $res.Close() }
}

function Install-Clau([string]$verb) {
  $latest = Get-Latest
  $file = $latest.files.$ZipName
  if (-not $file) { throw "릴리스에 $ZipName 이 없어요." }
  $work = Join-Path ([IO.Path]::GetTempPath()) ('clau-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    Say "클로 $($latest.version) 받는 중…"
    $zip = Join-Path $work $ZipName
    Get-File "$Base/$ZipName" $zip ([long]$file.size)
    Say '받은 파일을 확인하는 중…'
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne $file.sha256) { throw '받은 파일이 올라온 것과 달라요. 잠시 뒤 다시 해 주세요.' }
    Set-Progress 88
    Say '푸는 중…'
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $work)
    Set-Progress 94
    Say '바꿔 넣는 중…'
    # 처음 설치면 끝난 뒤 설치 마법사(--setup)를 연다.
    $fresh = -not (Test-Path -LiteralPath $Exe)
    Stop-Clau
    robocopy (Join-Path $work 'Clau-windows-x64\Clau') $Dest /MIR /NFL /NDL /NJH /NJS /NP /R:5 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw '설치 폴더에 복사하지 못했어요. 클로가 아직 켜져 있으면 끄고 다시 해 주세요.' }
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut)
    $link.TargetPath = $Exe
    $link.Description = '클로'
    $link.Save()
    Set-Progress 100
    if ($fresh) {
      Start-Process -FilePath $Exe -ArgumentList '--setup'
      Say "설치가 끝났어요. 화면에 뜬 설치 마법사에서 자리, 소리, 연결을 정하면 돼요."
      return
    }
    Start-Process -FilePath $Exe
    Say "$verb 끝났어요. 클로 $($latest.version)이 켜졌어요. 시작 메뉴에서 Clau 로 다시 열 수 있어요."
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Uninstall-Clau {
  $ok = [System.Windows.Forms.MessageBox]::Show('클로를 지울까요?', '클로 삭제', 'YesNo', 'Question')
  if ($ok -ne 'Yes') { return $false }
  $data = [System.Windows.Forms.MessageBox]::Show("설정(말투, 자리, 효과음 등)도 지울까요?`n아니요를 누르면 다시 설치했을 때 그대로 돌아와요.", '클로 삭제', 'YesNo', 'Question')
  Say '지우는 중…'
  $version = Get-InstalledVersion
  Stop-Clau
  # 0.6.35부터: Claude Code 연결, 자동 실행, ~/.claude/clau 를 앱이 스스로 거둔다.
  if ($version -and $version -ne '?' -and -not (Test-Newer '0.6.35' $version)) {
    try { Start-Process -FilePath $Exe -ArgumentList '--cleanup' -Wait } catch {}
  }
  $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (Test-Path $run) {
    $props = Get-ItemProperty -Path $run
    foreach ($p in $props.PSObject.Properties) {
      if ($p.Value -is [string] -and $p.Value -like "*\Clau\clau.exe*") { Remove-ItemProperty -Path $run -Name $p.Name -ErrorAction SilentlyContinue }
    }
  }
  Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Dest -Recurse -Force
  if ($data -eq 'Yes') { Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue }
  Say ('클로를 지웠어요.' + $(if ($data -eq 'Yes') { ' 설정도 지웠어요.' } else { ' 설정은 남겨 뒀어요.' }))
  return $true
}

# ── 지금 상태에 맞는 단추 ──
function Refresh {
  $panel.Controls.Clear()
  $bar.Visible = $false
  $installed = Get-InstalledVersion
  $latest = $null
  try { $latest = Get-Latest } catch {}
  $latestText = if ($latest) { $latest.version } else { '확인 못 함 (인터넷 연결을 확인해 주세요)' }
  if ($installed) {
    $info.Text = "설치된 버전: $installed`n최신 버전: $latestText"
    New-Button '열기' { Start-Process -FilePath $Exe; $form.Close() } | Out-Null
    if ($latest -and (Test-Newer $latest.version $installed)) { New-Button '업데이트' { Run-Task { Install-Clau '업데이트가' } } | Out-Null }
    New-Button '고치기' { Run-Task { Install-Clau '다시 설치가' } } | Out-Null
    New-Button '삭제' { Run-Task { Uninstall-Clau | Out-Null } } | Out-Null
  } else {
    $info.Text = "클로가 아직 설치되어 있지 않아요.`n최신 버전: $latestText"
    New-Button '설치' { Run-Task { Install-Clau '설치가' } } | Out-Null
  }
  New-Button '닫기' { $form.Close() } | Out-Null
}

function Run-Task([scriptblock]$task) {
  Set-Busy $true
  try {
    & $task
    $message = $info.Text
    Refresh
    $info.Text = $message
  } catch {
    $message = $_.Exception.Message
    Refresh
    $info.Text = "잘 안 됐어요: $message"
  } finally { Set-Busy $false }
}

$form.Add_Shown({ Set-Busy $true; Say '확인하는 중…'; Refresh; Set-Busy $false })
[void]$form.ShowDialog()
