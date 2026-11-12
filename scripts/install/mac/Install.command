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

if [ -x "$dest/Clau.app/Contents/MacOS/clau" ]; then
  "$dest/Clau.app/Contents/MacOS/clau" --quit >/dev/null 2>&1
  sleep 1
fi
rm -rf "$dest/Clau.app"
cp -R "Clau/Clau.app" "$dest/"
xattr -cr "$dest/Clau.app"
codesign --force --deep --sign - "$dest/Clau.app" >/dev/null 2>&1

open "$dest/Clau.app"
echo "설치했어요. $dest 의 Clau 를 열면 돼요."
