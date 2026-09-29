#!/bin/sh
# zega installer for Linux — https://install.zega.earth/linux.sh
#
#   curl -fsSL https://install.zega.earth/linux.sh | sh
#
# One script for every distro; the path is chosen from /etc/os-release
# (ID and ID_LIKE):
#   - Debian / Ubuntu and derivatives: phased apt setup ending in
#     `apt install zega`. Updates arrive with the normal system updates.
#   - Arch / Omarchy / EndeavourOS / Manjaro: the same phased flow against
#     zega's own signed pacman repository, ending in `pacman -S zega`.
#   - Anything else: the AppImage download. Never guesses a package manager.
#
# Prompts read from /dev/tty, so the script works when piped to sh.
# `--yes` (or `curl ... | sh -s -- --yes`) skips the prompts for scripted
# installs. sudo is used only on the lines that need root, and each step
# prints the exact command before it runs. Safe to run twice: a second run
# changes nothing and says so.
#
# ZEGA_RELEASES_BASE overrides the repository location; it exists so the
# script can be tested against a local copy of the repo layout (file://…)
# and is not part of the install flow.

set -eu

BASE=${ZEGA_RELEASES_BASE:-https://releases.zega.earth/desktop}

YES=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --help|-h)
      echo "usage: sh linux.sh [--yes]"
      echo "  --yes  skip the Enter-to-confirm prompts (for scripted installs)"
      exit 0
      ;;
    *) echo "linux.sh: unknown option $arg (try --help)" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || {
  echo "linux.sh: curl is required but not installed." >&2
  exit 1
}

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
else
  ID=""
  ID_LIKE=""
fi
DISTRO_TOKENS=" ${ID:-} ${ID_LIKE:-} "
DISTRO_NAME=${PRETTY_NAME:-${ID:-this system}}

confirm() {
  [ "$YES" -eq 1 ] && return 0
  printf '%s' "  Press Enter to continue (Ctrl-C to stop) "
  if ! read -r _ < /dev/tty; then
    echo
    echo "linux.sh: no terminal to confirm on; re-run with --yes for scripted installs." >&2
    exit 1
  fi
}

# Prints the exact command (with sudo only when it is actually used) and runs
# it. Only lines that need root go through here.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    printf '  $ %s\n' "$*"
    "$@"
  else
    printf '  $ sudo %s\n' "$*"
    sudo "$@"
  fi
}

# as_root for pipelines: prints the whole line, runs the root part with sudo
# only when needed. $1 = the display line, rest = the root-side command.
fetch_as_root() {
  url=$1; dest=$2
  if [ "$(id -u)" -eq 0 ]; then
    printf '  $ curl -fsSL %s -o %s\n' "$url" "$dest"
    curl -fsSL "$url" -o "$dest"
  else
    printf '  $ curl -fsSL %s | sudo tee %s > /dev/null\n' "$url" "$dest"
    curl -fsSL "$url" | sudo tee "$dest" > /dev/null
  fi
}

CHANGED=0

install_debian() {
  echo "zega installer for Ubuntu / Debian"
  echo
  keyring=/etc/apt/keyrings/zega.asc
  sources=/etc/apt/sources.list.d/zega.sources

  echo "Step 1 of 4: Add zega's signing key"
  echo "  Saves zega's public key to $keyring, so apt only accepts"
  echo "  packages signed by zega."
  confirm
  tmp=${TMPDIR:-/tmp}/zega.asc.$$
  curl -fsSL "$BASE/apt/zega.asc" -o "$tmp"
  if [ -f "$keyring" ] && cmp -s "$tmp" "$keyring"; then
    echo "  The key is already in place; nothing to change."
  else
    as_root install -d -m 0755 /etc/apt/keyrings
    as_root install -m 0644 "$tmp" "$keyring"
    CHANGED=1
  fi
  rm -f "$tmp"

  echo "Step 2 of 4: Add the zega repository"
  echo "  Writes $sources (signed-by the key above)."
  confirm
  wanted=$(printf 'Types: deb\nURIs: %s\nSuites: ./\nSigned-By: %s\n' "$BASE/apt" "$keyring")
  if [ -f "$sources" ] && [ "$(cat "$sources")" = "$wanted" ]; then
    echo "  The repository is already configured; nothing to change."
  else
    printf '  $ cat > %s <<EOF\n%s\nEOF\n' "$sources" "$wanted"
    if [ "$(id -u)" -eq 0 ]; then
      printf '%s\n' "$wanted" > "$sources"
    else
      printf '%s\n' "$wanted" | sudo tee "$sources" > /dev/null
    fi
    CHANGED=1
  fi

  echo "Step 3 of 4: Refresh the package list (apt update)"
  confirm
  as_root apt-get update

  echo "Step 4 of 4: Install zega (apt install zega)"
  confirm
  if dpkg-query -W -f='${Status}' zega 2>/dev/null | grep -q "install ok installed"; then
    echo "  zega is already installed; nothing to change."
  else
    as_root apt-get install -y zega
    CHANGED=1
  fi

  echo
  if [ "$CHANGED" -eq 0 ]; then
    echo "zega was already set up; this run changed nothing."
  fi
  echo "Done. From now on, updates arrive with your normal system updates."
}

install_arch() {
  echo "zega installer for Arch Linux"
  echo
  keyfile=${TMPDIR:-/tmp}/zega.asc.$$
  server="$BASE/arch/\$arch"

  echo "Step 1 of 4: Add zega's signing key"
  echo "  Saves zega's public key into pacman's keyring and marks it trusted,"
  echo "  so pacman only accepts packages signed by zega."
  confirm
  curl -fsSL "$BASE/arch/zega.asc" -o "$keyfile"
  fpr=$(gpg --show-keys --with-colons "$keyfile" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
  [ -n "$fpr" ] || { echo "linux.sh: could not read the fingerprint of $BASE/arch/zega.asc" >&2; rm -f "$keyfile"; exit 1; }
  # lsign needs the pacman master key's secret part; a system without it
  # (fresh container, hand-built install) gets one via pacman-key --init.
  # Normal Arch installs already have it, so this is a no-op there.
  if ! as_root gpg --homedir /etc/pacman.d/gnupg --batch --list-secret-keys 2>/dev/null | grep -q '^sec'; then
    as_root pacman-key --init
  fi
  if pacman-key --list-keys 2>/dev/null | grep -q "$fpr"; then
    echo "  The key is already trusted; nothing to change."
  else
    as_root pacman-key --add "$keyfile"
    as_root pacman-key --lsign-key "$fpr"
    CHANGED=1
  fi
  rm -f "$keyfile"

  echo "Step 2 of 4: Add the zega repository"
  echo "  Appends the [zega] repository to /etc/pacman.conf."
  confirm
  if grep -q '^\[zega\]' /etc/pacman.conf; then
    echo "  The repository is already configured; nothing to change."
  else
    block=$(printf '\n[zega]\nServer = %s\n' "$server")
    printf '  $ cat >> /etc/pacman.conf <<EOF\n%s\nEOF\n' "$block"
    if [ "$(id -u)" -eq 0 ]; then
      printf '%s\n' "$block" >> /etc/pacman.conf
    else
      printf '%s\n' "$block" | sudo tee -a /etc/pacman.conf > /dev/null
    fi
    CHANGED=1
  fi

  echo "Step 3 of 4: Refresh the package list (pacman -Sy)"
  confirm
  as_root pacman -Sy

  echo "Step 4 of 4: Install zega (pacman -S zega)"
  confirm
  if pacman -Qq zega >/dev/null 2>&1; then
    echo "  zega is already installed; nothing to change."
  else
    as_root pacman -S --needed --noconfirm zega
    CHANGED=1
  fi

  echo
  if [ "$CHANGED" -eq 0 ]; then
    echo "zega was already set up; this run changed nothing."
  fi
  echo "Done. From now on, updates arrive with your normal system updates (pacman -Syu)."
}

install_appimage() {
  echo "zega installer for Linux"
  echo
  echo "zega does not have a native package for $DISTRO_NAME yet."
  echo "The AppImage is the direct download; it updates itself."
  echo
  url=$(curl -fsSL "$BASE/stable.json" 2>/dev/null | sed -n 's/.*"\(https:\/\/[^"]*linux-x86_64\.AppImage\)".*/\1/p' | head -n 1 || true)
  if [ -n "$url" ]; then
    echo "  $ curl -fLO $url"
    echo "  $ chmod +x $(basename "$url")"
    echo "  $ ./$(basename "$url")"
  else
    echo "Download the latest zega AppImage for linux-x86_64 from:"
    echo "  https://releases.zega.earth/desktop/stable.json (see platforms.linux-x86_64.url)"
  fi
  echo
  echo "On Arch-based systems without the [zega] repo, AppImages need fuse2:"
  echo "  $ sudo pacman -S fuse2"
}

case "$DISTRO_TOKENS" in
  # elementary OS (and a few others) list only ubuntu in ID_LIKE.
  *" debian "*|*" ubuntu "*) install_debian ;;
  *" arch "*) install_arch ;;
  *) install_appimage ;;
esac
