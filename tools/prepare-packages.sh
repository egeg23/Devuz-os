#!/bin/bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Готовит mkosi.packages/ перед сборкой (в Actions и у себя):
#  1) собирает пустой пакет devuz-no-initramfs (чтобы не ставился dracut);
#  2) скачивает .deb ядра из GitHub Release, версия — в kernel.lock.
# mkosi ставит пакеты из mkosi.packages/ с приоритетом выше backports,
# поэтому в образ попадает именно закреплённое ядро.
set -euo pipefail
cd "$(dirname "$0")/.."

out=mkosi.packages
mkdir -p "$out"
rm -f "$out"/*.deb

dpkg-deb --root-owner-group --build packages/devuz-no-initramfs "$out/" >/dev/null
echo "Собран $(ls "$out"/devuz-no-initramfs_*.deb)"

# shellcheck disable=SC1091
. ./kernel.lock
tag="kernel-${KERNEL_VERSION//\~/_}"

if command -v gh >/dev/null && gh release view "$tag" >/dev/null 2>&1; then
    gh release download "$tag" --pattern '*.deb' --dir "$out" --clobber
    echo "Ядро $KERNEL_VERSION взято из Release $tag:"
    ls -1 "$out"/linux-*.deb
    [ -n "${GITHUB_ENV:-}" ] && echo "KERNEL_PINNED=$KERNEL_VERSION" >>"$GITHUB_ENV"
else
    msg="Release $tag не найден (или нет gh) — ядро возьмётся из trixie-backports, какое там есть сейчас"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::$msg"; else echo "ВНИМАНИЕ: $msg"; fi
fi
