#!/bin/sh
# 클로 설치 도우미 (macOS, Linux). 이 파일 하나로 설치, 업데이트, 고치기(다시 설치), 삭제, 열기를 한다.
#   macOS: Clau-Installer-macOS.command 를 우클릭 → 열기
#   Linux: Clau-Installer-Linux.sh 를 실행(파일 관리자에서 실행 허용, 또는 sh 로)
# 창은 macOS 대화상자, KDE(kdialog), GNOME(zenity)으로 띄우고, 없으면 터미널에서 묻는다.
set -u

REPO="${CLAU_REPO:-OCGK123/clau}"
BASE="https://github.com/$REPO/releases/latest/download"
TITLE="클로 설치 도우미"
OS=$(uname -s)

case "$OS/$(uname -m)" in
  Linux/x86_64 | Linux/amd64) TARGET=linux-x64 ;;
  Darwin/arm64) TARGET=mac-apple-silicon ;;
  Darwin/x86_64) TARGET=mac-intel ;;
  *) TARGET="" ;;
esac

# ── 어디에 깔려 있나 ──
if [ "$OS" = Darwin ]; then
  APP=""
  for d in /Applications "$HOME/Applications"; do [ -d "$d/Clau.app" ] && { APP="$d/Clau.app"; break; }; done
  BIN="${APP:+$APP/Contents/MacOS/clau}"
  PKG="${APP:+$APP/Contents/Resources/app/package.json}"
  DATA="$HOME/Library/Application Support/Clau"
else
  SHARE="${XDG_DATA_HOME:-$HOME/.local/share}"
  APP="$SHARE/clau"
  [ -x "$APP/clau" ] || APP=""
  BIN="${APP:+$APP/clau}"
  PKG="${APP:+$APP/resources/app/package.json}"
  DATA="${XDG_CONFIG_HOME:-$HOME/.config}/Clau"
fi

# ── 창 띄우기 ──
if [ -n "${CLAU_INSTALLER_UI:-}" ]; then UI=$CLAU_INSTALLER_UI # 시험용
elif [ "$OS" = Darwin ]; then UI=mac
elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v kdialog >/dev/null 2>&1; then UI=kde
elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v zenity >/dev/null 2>&1; then UI=gnome
else UI=tty
fi

osa() { osascript - "$@" 2>/dev/null; }

ui_info() {
  case $UI in
    mac) osa "$1" "$TITLE" <<'EOF' >/dev/null
on run argv
  display dialog (item 1 of argv) buttons {"확인"} default button 1 with title (item 2 of argv)
end run
EOF
    ;;
    kde) kdialog --title "$TITLE" --msgbox "$1" ;;
    gnome) zenity --info --title="$TITLE" --text="$1" --no-wrap ;;
    *) printf '\n%s\n' "$1" >&2 ;;
  esac
}

ui_error() {
  case $UI in
    kde) kdialog --title "$TITLE" --error "$1" ;;
    gnome) zenity --error --title="$TITLE" --text="$1" --no-wrap ;;
    *) ui_info "$1" ;;
  esac
}

# 예/아니요. 예면 0.
ui_yesno() {
  case $UI in
    mac) [ "$(osa "$1" "$TITLE" <<'EOF'
on run argv
  button returned of (display dialog (item 1 of argv) buttons {"아니요", "예"} default button 2 with title (item 2 of argv))
end run
EOF
)" = "예" ] ;;
    kde) kdialog --title "$TITLE" --yesno "$1" ;;
    gnome) zenity --question --title="$TITLE" --text="$1" --no-wrap ;;
    *) printf '\n%s [y/N] ' "$1" >&2; read -r a; [ "$a" = y ] || [ "$a" = Y ] ;;
  esac
}

# 할 일 고르기: ui_menu "설명" 이름1 이름2 ... → 고른 이름(없으면 빈 값)
ui_menu() {
  prompt=$1; shift
  case $UI in
    mac) r=$(osa "$prompt" "$TITLE" "$@" <<'EOF'
on run argv
  set choices to items 3 thru -1 of argv
  set picked to choose from list choices with title (item 2 of argv) with prompt (item 1 of argv) default items {item 1 of choices} OK button name "하기" cancel button name "닫기"
  if picked is false then return ""
  return item 1 of picked
end run
EOF
)
       printf '%s' "$r" ;;
    kde) set -- $(for x in "$@"; do printf '%s %s ' "$x" "$x"; done)
         kdialog --title "$TITLE" --menu "$prompt" "$@" 2>/dev/null ;;
    gnome) zenity --list --title="$TITLE" --text="$prompt" --column="할 일" --hide-header --height=300 "$@" 2>/dev/null ;;
    *) printf '\n%s\n' "$prompt" >&2
       i=1; for x in "$@"; do printf '  %s) %s\n' "$i" "$x" >&2; i=$((i + 1)); done
       printf '번호: ' >&2; read -r n
       i=1; for x in "$@"; do [ "$i" = "$n" ] && printf '%s' "$x"; i=$((i + 1)); done ;;
  esac
}

# 진행 막대
PROGRESS=""
progress_start() {
  case $UI in
    kde) PROGRESS=$(kdialog --title "$TITLE" --progressbar "$1" 100 2>/dev/null) ;;
    gnome) PIPE=$(mktemp -u); mkfifo "$PIPE"; zenity --progress --title="$TITLE" --text="$1" --auto-close --no-cancel <"$PIPE" & exec 3>"$PIPE"; PROGRESS=gnome ;;
    *) printf '%s\n' "$1" ;;
  esac
}
progress_set() { # 퍼센트 [글]
  case $UI in
    kde) [ -n "$PROGRESS" ] && { qdbus6 $PROGRESS Set "" value "$1" >/dev/null 2>&1 || qdbus $PROGRESS Set "" value "$1" >/dev/null 2>&1; }
         [ -n "${2:-}" ] && { qdbus6 $PROGRESS setLabelText "$2" >/dev/null 2>&1 || qdbus $PROGRESS setLabelText "$2" >/dev/null 2>&1; } ;;
    gnome) [ -n "${2:-}" ] && printf '# %s\n' "$2" >&3; printf '%s\n' "$1" >&3 ;;
    *) [ -n "${2:-}" ] && printf '%s\n' "$2"; printf '\r%3s%%' "$1" ;;
  esac
  return 0
}
progress_end() {
  case $UI in
    kde) [ -n "$PROGRESS" ] && { qdbus6 $PROGRESS close >/dev/null 2>&1 || qdbus $PROGRESS close >/dev/null 2>&1; } ;;
    gnome) [ -n "$PROGRESS" ] && { printf '100\n' >&3; exec 3>&-; rm -f "$PIPE"; } ;;
    *) printf '\n' ;;
  esac
  PROGRESS=""
}

# ── 도구 ──
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1"; }
  download() { curl -fsSL -o "$2" "$1"; }
else
  fetch() { wget -qO- "$1"; }
  download() { wget -qO "$2" "$1"; }
fi
if command -v sha256sum >/dev/null 2>&1; then hash() { sha256sum "$1" | cut -d' ' -f1; }
else hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi
size_of() { if [ -f "$1" ]; then wc -c <"$1" | tr -d ' '; else echo 0; fi; }
version_of() { [ -n "$1" ] && [ -f "$1" ] && sed -n 's/.*"version" *: *"\([0-9.]*\)".*/\1/p' "$1" | head -n 1; }
# $1 이 $2 보다 새 버전이면 0
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 1 }'
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
LATEST=""
LATEST_SHA=""
LATEST_SIZE=""
read_latest() {
  [ -n "$LATEST" ] && return 0
  fetch "$BASE/latest.json" >"$WORK/latest.json" 2>/dev/null || return 1
  LATEST=$(sed -n 's/.*"version" *: *"\([0-9.]*\)".*/\1/p' "$WORK/latest.json" | head -n 1)
  name="Clau-$TARGET.zip"
  block=$(tr ',{}' '\n\n\n' <"$WORK/latest.json" | sed -n "/\"$name\"/,/sha256/p")
  LATEST_SHA=$(printf '%s\n' "$block" | sed -n 's/.*"sha256" *: *"\([0-9a-f]\{64\}\)".*/\1/p' | head -n 1)
  LATEST_SIZE=$(tr ',{}' '\n\n\n' <"$WORK/latest.json" | sed -n "/\"$name\"/,/size/p" | sed -n 's/.*"size" *: *\([0-9]*\).*/\1/p' | head -n 1)
  [ -n "$LATEST" ]
}

stop_clau() {
  [ -n "$BIN" ] && [ -x "$BIN" ] && "$BIN" --quit >/dev/null 2>&1
  sleep 1
}

install_clau() { # 설치·업데이트·고치기 모두 최신 버전을 새로 깐다. 설정은 그대로.
  verb=$1
  read_latest || { ui_error "릴리스 정보를 받지 못했어요. 인터넷 연결을 확인해 주세요."; return 1; }
  [ -n "$LATEST_SHA" ] || { ui_error "이 컴퓨터용 클로가 릴리스에 없어요."; return 1; }
  zip="$WORK/Clau-$TARGET.zip"
  progress_start "클로 $LATEST 받는 중…"
  download "$BASE/Clau-$TARGET.zip" "$zip" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    got=$(size_of "$zip"); got=${got:-0}
    [ -n "$LATEST_SIZE" ] && [ "$LATEST_SIZE" -gt 0 ] && progress_set $((got * 90 / LATEST_SIZE))
    sleep 0.3
  done
  if ! wait "$pid"; then progress_end; ui_error "내려받지 못했어요. 인터넷 연결을 확인해 주세요."; return 1; fi
  progress_set 92 "받은 파일을 확인하는 중…"
  if [ "$(hash "$zip")" != "$LATEST_SHA" ]; then progress_end; ui_error "받은 파일이 올라온 것과 달라요. 잠시 뒤 다시 해 주세요."; return 1; fi
  progress_set 95 "설치하는 중…"
  if [ "$OS" = Darwin ]; then
    ditto -x -k "$zip" "$WORK" && sh "$WORK/Clau-$TARGET/Install.command" >"$WORK/install.log" 2>&1
  else
    unzip -q "$zip" -d "$WORK" && sh "$WORK/Clau-$TARGET/install.sh" >"$WORK/install.log" 2>&1
  fi
  ok=$?
  progress_end
  if [ $ok -ne 0 ]; then ui_error "설치하지 못했어요. $(tail -n 2 "$WORK/install.log" 2>/dev/null)"; return 1; fi
  # 처음 설치면 설치 스크립트가 클로를 설치 마법사(--setup)와 함께 연다.
  if [ -z "$installed" ]; then ui_info "설치가 끝났어요. 화면에 뜬 설치 마법사에서 자리, 소리, 연결을 정하면 돼요."
  else ui_info "$verb 끝났어요. 클로 $LATEST 이 켜졌어요."; fi
}

uninstall_clau() {
  ui_yesno "클로를 지울까요?" || return 0
  keep=1
  ui_yesno "설정(말투, 자리, 효과음 등)도 지울까요?
아니요를 누르면 다시 설치했을 때 그대로 돌아와요." && keep=0
  version=$(version_of "$PKG")
  stop_clau
  # 0.6.35부터: Claude Code 연결, 자동 실행, ~/.claude/clau 를 앱이 스스로 거둔다.
  if [ -n "$version" ] && ! newer 0.6.35 "$version"; then "$BIN" --cleanup >/dev/null 2>&1; fi
  rm -rf "$APP"
  if [ "$OS" != Darwin ]; then
    rm -f "$SHARE/applications/clau.desktop" "$HOME/.local/bin/clau" "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/clau.desktop"
  fi
  if [ $keep -eq 0 ]; then rm -rf "$DATA"; ui_info "클로와 설정을 지웠어요."
  else ui_info "클로를 지웠어요. 설정은 남겨 뒀어요."; fi
}

open_clau() {
  if [ "$OS" = Darwin ]; then open "$APP"
  else nohup "$BIN" >/dev/null 2>&1 &
  fi
}

[ -n "$TARGET" ] || { ui_error "이 컴퓨터($(uname -s) $(uname -m))용 클로는 아직 없어요."; exit 1; }
[ "$OS" = Darwin ] || command -v unzip >/dev/null 2>&1 || { ui_error "unzip 이 있어야 해요. (예: sudo apt install unzip)"; exit 1; }

# ── 할 일 고르기 ──
read_latest
installed=$(version_of "$PKG")
latest_text=${LATEST:-"확인 못 함"}
if [ -n "$installed" ]; then
  if [ -n "$LATEST" ] && newer "$LATEST" "$installed"; then
    pick=$(ui_menu "설치된 버전: $installed
최신 버전: $latest_text" "업데이트" "열기" "고치기" "삭제")
  else
    pick=$(ui_menu "설치된 버전: $installed
최신 버전: $latest_text" "열기" "고치기" "삭제")
  fi
else
  pick=$(ui_menu "클로가 아직 설치되어 있지 않아요.
최신 버전: $latest_text" "설치")
fi

case "$pick" in
  설치)
    ui_yesno "클로 $latest_text 을 설치할까요?
1. 최신 버전을 받아 올라온 파일과 같은지 확인합니다.
2. 이 컴퓨터에 설치합니다.
3. 설치 마법사에서 자리, 소리, 연결을 정합니다." && install_clau "설치가" ;;
  업데이트) install_clau "업데이트가" ;;
  고치기) install_clau "다시 설치가" ;;
  삭제) uninstall_clau ;;
  열기) open_clau ;;
esac
