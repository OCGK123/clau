#!/bin/sh
# 클로를 응용 프로그램 폴더에 넣고 연다.
# 서명·공증이 없는 앱이라, 내려받을 때 붙은 격리 표시를 떼고 이 컴퓨터에서 서명해 둔다.
cd "$(dirname "$0")" || exit 1

if [ ! -d "Clau/Clau.app" ]; then
  echo "이 파일 옆에 Clau 폴더가 있어야 해요."
  exit 1
fi

dest="/Applications"
[ -w "$dest" ] || dest="$HOME/Applications"
mkdir -p "$dest"

# 처음 설치하는 것인지 본다. 처음이면 끝난 뒤 설치 마법사를 연다.
fresh=1
if [ -x "$dest/Clau.app/Contents/MacOS/clau" ]; then
  fresh=0
  echo "[1/4] 떠 있던 클로를 끄는 중..."
  "$dest/Clau.app/Contents/MacOS/clau" --quit >/dev/null 2>&1
  sleep 1
else
  echo "[1/4] 새로 설치합니다."
fi
echo "[2/4] $dest 에 복사하는 중..."
rm -rf "$dest/Clau.app"
cp -R "Clau/Clau.app" "$dest/"
echo "[3/4] 이 컴퓨터에서 열 수 있게 준비하는 중..."
xattr -cr "$dest/Clau.app"
codesign --force --deep --sign - "$dest/Clau.app" >/dev/null 2>&1

echo "[4/4] 클로를 여는 중..."
if [ "$fresh" = 1 ]; then
  open "$dest/Clau.app" --args --setup
  echo "설치했어요. 화면에 뜬 설치 마법사를 따라가면 돼요."
else
  open "$dest/Clau.app"
  echo "업데이트했어요. 설정은 그대로 남아 있어요."
fi
