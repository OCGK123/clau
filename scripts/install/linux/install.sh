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

# 떠 있던 클로는 끄고 새 걸로 바꾼다. 처음 설치라면 끝난 뒤 설치 마법사를 연다.
fresh=1
if [ -x "$dest/clau" ]; then
  fresh=0
  echo "[1/4] 떠 있던 클로를 끄는 중..."
  "$dest/clau" --quit >/dev/null 2>&1 || true
  sleep 1
else
  echo "[1/4] 새로 설치합니다."
fi
echo "[2/4] $dest 에 복사하는 중..."
rm -rf "$dest"
mkdir -p "$dest" "$data/applications" "$bin"
cp -R "$here/Clau/." "$dest/"

echo "[3/4] 앱 메뉴와 clau 명령을 만드는 중..."
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

echo "[4/4] 클로를 여는 중..."
if [ "$fresh" = 1 ]; then
  nohup "$dest/clau" --setup >/dev/null 2>&1 &
  echo "설치했어요. 화면에 뜬 설치 마법사를 따라가면 돼요."
else
  nohup "$dest/clau" >/dev/null 2>&1 &
  echo "업데이트했어요. 설정은 그대로 남아 있어요."
fi
echo "앱 메뉴에서 '클로'를 찾거나 터미널에서 clau 라고 치면 돼요."
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "(clau 명령을 쓰려면 $bin 이 PATH에 있어야 해요.)" ;;
esac
