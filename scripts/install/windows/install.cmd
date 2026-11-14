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

rem 처음 설치하는 것인지 본다. 처음이면 끝난 뒤 설치 마법사를 연다.
set "FRESH=1"
if exist "%DEST%\clau.exe" (
  set "FRESH=0"
  echo [1/4] 떠 있던 클로를 끄는 중...
  start "" /wait "%DEST%\clau.exe" --quit
  timeout /t 1 /nobreak >nul
) else (
  echo [1/4] 새로 설치합니다.
)
echo [2/4] %DEST% 에 복사하는 중...
robocopy "%SRC%" "%DEST%" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo 복사하지 못했어요. 다른 프로그램이 클로 파일을 쓰고 있는지 확인해 주세요.
  pause
  exit /b 1
)

echo [3/4] 시작 메뉴에 넣는 중...
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Programs') + '\Clau.lnk'); $s.TargetPath = $env:LOCALAPPDATA + '\Clau\clau.exe'; $s.Save()"

echo [4/4] 클로를 여는 중...
if "%FRESH%"=="1" (
  start "" "%DEST%\clau.exe" --setup
  echo 설치했어요. 화면에 뜬 설치 마법사를 따라가면 돼요.
) else (
  start "" "%DEST%\clau.exe"
  echo 업데이트했어요. 설정은 그대로 남아 있어요.
)
pause
