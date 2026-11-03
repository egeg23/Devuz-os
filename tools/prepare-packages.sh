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

# kernel.lock — данные: читаем построчно, не выполняем.
KERNEL_VERSION=$(sed -n 's/^KERNEL_VERSION=//p' kernel.lock)
[[ "$KERNEL_VERSION" =~ ^[0-9][0-9A-Za-z.~+-]*$ ]] || { echo "kernel.lock: плохая KERNEL_VERSION «$KERNEL_VERSION»" >&2; exit 1; }
sums=$(sed -n 's/^KERNEL_SHA256=//p' kernel.lock)
tag="kernel-${KERNEL_VERSION//\~/_}"

if [ -z "$sums" ]; then
    msg="в kernel.lock нет KERNEL_SHA256 — ядро из Release не берём, возьмётся из trixie-backports"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::warning::$msg"; else echo "ВНИМАНИЕ: $msg"; fi
elif command -v gh >/dev/null && gh release view "$tag" >/dev/null 2>&1; then
    gh release download "$tag" --pattern '*.deb' --dir "$out" --clobber
    # Только пакеты из kernel.lock и только с совпавшим хешем.
    for f in "$out"/linux-*.deb; do
        grep -qF " $(basename "$f")" <<<"$sums" || { echo "Release $tag: лишний файл $(basename "$f") — нет в kernel.lock" >&2; exit 1; }
    done
    (cd "$out" && sha256sum --strict -c - <<<"$(awk '{print $1"  "$2}' <<<"$sums")")
    echo "Ядро $KERNEL_VERSION взято из Release $tag, хеши совпали с kernel.lock:"
    ls -1 "$out"/linux-*.deb
    [ -n "${GITHUB_ENV:-}" ] && echo "KERNEL_PINNED=$KERNEL_VERSION" >>"$GITHUB_ENV"
else
    # Ядро закреплено (есть хеши), а Release нет — не подменяем его молча
    # чем-то из backports: в образ попало бы не то ядро, что в kernel.lock.
    echo "Release $tag не найден (или нет gh), а в kernel.lock закреплено ядро $KERNEL_VERSION — сборка остановлена" >&2
    exit 1
fi
