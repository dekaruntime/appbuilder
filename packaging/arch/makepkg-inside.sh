#!/usr/bin/env bash
# Runs INSIDE the archlinux container (as root); see build-in-docker.sh.
# makepkg refuses to run as root, so the build itself happens as `builder`
# on a writable copy of the checkout (git archive of HEAD — tracked files
# only, so node_modules and .target never leak in).
set -euo pipefail

: "${ZEGA_PKGVER:?ZEGA_PKGVER (from tauri.conf.json) is required}"

pacman -Syu --noconfirm --needed \
  base-devel git rustup nodejs npm pkgconf sccache \
  webkit2gtk-4.1 gtk3 libappindicator-gtk3 librsvg

useradd --create-home builder
mkdir -p /build/zega
# The mounted checkout is owned by the host user, not root.
git config --global --add safe.directory /src
git -C /src archive HEAD | tar -x -C /build/zega
sed -i "s/^pkgver=.*/pkgver=$ZEGA_PKGVER/" /build/zega/packaging/arch/PKGBUILD
chown -R builder:builder /build

su builder -s /bin/bash -c '
  set -euo pipefail
  cd /build/zega/packaging/arch
  export PKGDEST=/build/zega BUILDDIR=/build/work SRCDEST=/build/src
  makepkg -f --noconfirm
'

cp /build/zega/zega-"$ZEGA_PKGVER"-1-x86_64.pkg.tar.zst /out/
echo "built /out/zega-$ZEGA_PKGVER-1-x86_64.pkg.tar.zst"
