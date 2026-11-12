#!/bin/sh
# install.sh 가 만든 것을 지운다. 설정(~/.config/Clau)은 남겨 둔다.
data="${XDG_DATA_HOME:-$HOME/.local/share}"
dest="$data/clau"

[ -x "$dest/clau" ] && "$dest/clau" --quit >/dev/null 2>&1
sleep 1
rm -rf "$dest"
rm -f "$data/applications/clau.desktop" "$HOME/.local/bin/clau" "$HOME/.config/autostart/clau.desktop"
echo "지웠어요. 설정까지 지우려면 ~/.config/Clau 폴더를 지우면 돼요."
