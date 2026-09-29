#!/usr/bin/env bash
# Build the zega pacman package inside a throwaway archlinux container.
# No secrets: the package leaves unsigned; scripts/publish-release.mjs signs
# it (and the repo metadata) at publish time.
#
#   packaging/arch/build-in-docker.sh [output-dir]
#
# The output directory (default <repo>/.tmp/arch) receives
# zega-<ver>-1-x86_64.pkg.tar.zst. pkgver comes from src-tauri/tauri.conf.json.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/.tmp/arch}" && cd "${1:-$ROOT/.tmp/arch}" && pwd)
VERSION=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")

docker run --rm \
  -v "$ROOT:/src:ro" \
  -v "$OUT:/out" \
  -e "ZEGA_PKGVER=$VERSION" \
  archlinux:latest bash /src/packaging/arch/makepkg-inside.sh
