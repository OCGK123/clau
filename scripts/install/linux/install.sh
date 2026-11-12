#!/bin/sh
# 클로를 ~/.local/share/clau 에 설치하고, 앱 메뉴 항목과 터미널 명령(clau)을 만든다.
set -e
here=$(cd "$(dirname "$0")" && pwd)
data="${XDG_DATA_HOME:-$HOME/.local/share}"
dest="$data/clau"
bin="$HOME/.local/bin"

if [ ! -x "$here/Clau/clau" ]; then
  echo "이 파일 옆에 Clau 폴더가 있어야 해요."
  exit 1
fi

# 떠 있던 클로는 끄고 새 걸로 바꾼다.
if [ -x "$dest/clau" ]; then
  "$dest/clau" --quit >/dev/null 2>&1 || true
  sleep 1
fi
rm -rf "$dest"
mkdir -p "$dest" "$data/applications" "$bin"
cp -R "$here/Clau/." "$dest/"

printf '#!/bin/sh\nexec "%s/clau" "$@"\n' "$dest" > "$bin/clau"
chmod +x "$bin/clau"

cat > "$data/applications/clau.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Clau
Name[ko]=클로
Comment[ko]=Claude 창에 사는 작은 친구
Exec="$dest/clau"
Icon=$dest/resources/app/assets/icon.png
Categories=Utility;
StartupNotify=false
DESKTOP

nohup "$dest/clau" >/dev/null 2>&1 &

echo "설치했어요. 앱 메뉴에서 '클로'를 찾거나 터미널에서 clau 라고 치면 돼요."
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "(clau 명령을 쓰려면 $bin 이 PATH에 있어야 해요.)" ;;
esac
