# 클로 한 줄 설치 (Windows)
#   irm https://raw.githubusercontent.com/OCGK123/clau/main/install.ps1 | iex
# GitHub 릴리스에서 최신 버전을 받아, 올라온 sha256과 맞는지 본 뒤 %LOCALAPPDATA%\Clau 에 설치하고 켠다.
# 이미 깔려 있으면 새 버전으로 바꾼다. 설정은 그대로 남는다. 관리자 권한은 필요 없다.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # 진행 막대가 내려받기를 크게 느리게 만든다
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = if ($env:CLAU_REPO) { $env:CLAU_REPO } else { 'OCGK123/clau' }
$base = "https://github.com/$repo/releases/latest/download"
$name = 'Clau-windows-x64.zip'
if (-not [Environment]::Is64BitOperatingSystem) { throw '64비트 Windows에서만 쓸 수 있어요.' }

$work = Join-Path ([IO.Path]::GetTempPath()) ("clau-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  Write-Host '클로 최신 버전을 찾는 중…'
  $latest = Invoke-RestMethod "$base/latest.json"
  $file = $latest.files.$name
  if (-not $file) { throw "릴리스에 $name 이 없어요." }

  Write-Host "클로 $($latest.version) 받는 중"
  $zip = Join-Path $work $name
  Invoke-WebRequest "$base/$name" -OutFile $zip -UseBasicParsing
  if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $file.sha256) { throw '받은 파일이 올라온 것과 달라요. 잠시 뒤 다시 해 주세요.' }

  Expand-Archive $zip -DestinationPath $work -Force
  $src = Join-Path $work 'Clau-windows-x64\Clau'
  $dest = Join-Path $env:LOCALAPPDATA 'Clau'

  # 떠 있던 클로는 끄고 바꾼다.
  $exe = Join-Path $dest 'clau.exe'
  if (Test-Path $exe) {
    Start-Process $exe -ArgumentList '--quit' -Wait -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
  }
  robocopy $src $dest /MIR /NFL /NDL /NJH /NJS /NP /R:5 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw '설치 폴더에 복사하지 못했어요.' }

  $link = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Clau.lnk'))
  $link.TargetPath = $exe
  $link.Description = '클로'
  $link.Save()

  Start-Process $exe
  Write-Host '설치했어요. 시작 메뉴에서 Clau 를 찾으면 돼요.'
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
