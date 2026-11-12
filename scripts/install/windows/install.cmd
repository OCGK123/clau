@echo off
chcp 65001 >nul
setlocal
rem 클로를 %LOCALAPPDATA%\Clau 에 설치하고 시작 메뉴에 넣는다.
set "SRC=%~dp0Clau"
set "DEST=%LOCALAPPDATA%\Clau"

if not exist "%SRC%\clau.exe" (
  echo 이 파일 옆에 Clau 폴더가 있어야 해요.
  pause
  exit /b 1
)

if exist "%DEST%\clau.exe" (
  start "" /wait "%DEST%\clau.exe" --quit
  timeout /t 1 /nobreak >nul
)
robocopy "%SRC%" "%DEST%" /MIR /NFL /NDL /NJH /NJS /NP >nul

powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Programs') + '\Clau.lnk'); $s.TargetPath = $env:LOCALAPPDATA + '\Clau\clau.exe'; $s.Save()"

start "" "%DEST%\clau.exe"
echo 설치했어요. 시작 메뉴에서 Clau 를 찾으면 돼요.
pause
