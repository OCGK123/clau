#!/bin/sh
# 클로 한 줄 설치 (Linux, macOS)
#   curl -fsSL https://raw.githubusercontent.com/OCGK123/clau/main/install.sh | sh
# GitHub 릴리스에서 이 컴퓨터에 맞는 최신 버전을 받아, 올라온 sha256과 맞는지 본 뒤 설치하고 켠다.
# 이미 깔려 있으면 새 버전으로 바꾼다. 설정은 그대로 남는다.
set -eu

REPO="${CLAU_REPO:-OCGK123/clau}"
BASE="https://github.com/$REPO/releases/latest/download"

say() { printf '%s\n' "$*"; }
die() { say "$*" >&2; exit 1; }

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64 | Linux/amd64) target=linux-x64 ;;
  Darwin/arm64) target=mac-apple-silicon ;;
  Darwin/x86_64) target=mac-intel ;;
  *) die "이 컴퓨터($(uname -s) $(uname -m))용 클로는 아직 없어요." ;;
esac

if command -v curl >/dev/null 2>&1; then
  get() { curl -fL --progress-bar -o "$2" "$1"; }
  peek() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  get() { wget -q --show-progress -O "$2" "$1"; }
  peek() { wget -qO- "$1"; }
else
  die "curl이나 wget이 있어야 해요."
fi

if command -v sha256sum >/dev/null 2>&1; then
  hash() { sha256sum "$1" | cut -d' ' -f1; }
else
  hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

name="Clau-$target.zip"
say "클로 최신 버전을 찾는 중…"
peek "$BASE/latest.json" > "$work/latest.json" || die "릴리스 정보를 받지 못했어요. 인터넷 연결을 확인해 주세요."
version=$(sed -n 's/.*"version" *: *"\([0-9.]*\)".*/\1/p' "$work/latest.json" | head -n 1)
# latest.json 에서 이 파일의 sha256 만 골라낸다(한 줄짜리 JSON이어도 된다).
want=$(tr ',{}' '\n\n\n' < "$work/latest.json" | sed -n "/\"$name\"/,/sha256/p" | sed -n 's/.*"sha256" *: *"\([0-9a-f]\{64\}\)".*/\1/p' | head -n 1)
[ -n "$want" ] || die "릴리스에 $name 이 없어요."

say "클로 $version 받는 중 ($target)"
get "$BASE/$name" "$work/$name" || die "내려받지 못했어요."
[ "$(hash "$work/$name")" = "$want" ] || die "받은 파일이 올라온 것과 달라요. 잠시 뒤 다시 해 주세요."

if [ "$target" = linux-x64 ]; then
  command -v unzip >/dev/null 2>&1 || die "unzip 이 있어야 해요. (예: sudo apt install unzip)"
  unzip -q "$work/$name" -d "$work"
  sh "$work/Clau-$target/install.sh"
else
  # ditto 는 맥 앱 안의 링크와 권한을 그대로 푼다.
  ditto -x -k "$work/$name" "$work"
  sh "$work/Clau-$target/Install.command"
fi
