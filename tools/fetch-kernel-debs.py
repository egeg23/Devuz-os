#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Скачивает .deb ядра нужной версии из trixie-backports.

Берёт индекс Packages.xz из deb.debian.org, выбирает пакеты ядра этой
версии (linux-image-amd64 и всё, что он тянет из исходников linux и
linux-signed-amd64), а также linux-base, сверяет SHA256 с индексом.

Запуск: fetch-kernel-debs.py <версия, например 7.2.11-1~bpo13+1> <каталог>
"""
import hashlib
import lzma
import pathlib
import sys
import urllib.request

MIRROR = "https://deb.debian.org/debian"
INDEX = f"{MIRROR}/dists/trixie-backports/main/binary-amd64/Packages.xz"


def parse(text: str) -> list[dict[str, str]]:
    out = []
    for block in text.split("\n\n"):
        fields: dict[str, str] = {}
        key = None
        for line in block.splitlines():
            if line.startswith((" ", "\t")) and key:
                fields[key] += "\n" + line
            elif ":" in line:
                key, _, val = line.partition(":")
                fields[key] = val.strip()
        if "Package" in fields:
            out.append(fields)
    return out


def main() -> int:
    version, dest = sys.argv[1], pathlib.Path(sys.argv[2])
    dest.mkdir(parents=True, exist_ok=True)

    with urllib.request.urlopen(INDEX) as r:
        pkgs = parse(lzma.decompress(r.read()).decode())

    def source(p: dict[str, str]) -> str:
        return p.get("Source", p["Package"]).split()[0]

    chosen = [
        p for p in pkgs
        if p["Version"] == version and source(p) in ("linux", "linux-signed-amd64")
        and p["Package"].startswith(("linux-image-", "linux-binary-", "linux-modules-", "linux-base-"))
        and p["Package"].endswith("-amd64") and "-dbg" not in p["Package"]
        and "-unsigned" not in p["Package"] and "-rt-" not in p["Package"] and "-cloud-" not in p["Package"]
    ]
    chosen += [p for p in pkgs if p["Package"] == "linux-base"]

    names = sorted(p["Package"] for p in chosen)
    if "linux-image-amd64" not in names:
        print(f"ОШИБКА: в trixie-backports нет linux-image-amd64 {version}", file=sys.stderr)
        print("(backports хранит только последнюю версию — поменяйте kernel.lock)", file=sys.stderr)
        return 1

    for p in chosen:
        url = f"{MIRROR}/{p['Filename']}"
        path = dest / p["Filename"].rsplit("/", 1)[1]
        with urllib.request.urlopen(url) as r:
            data = r.read()
        if hashlib.sha256(data).hexdigest() != p["SHA256"]:
            print(f"ОШИБКА: SHA256 не совпал для {path.name}", file=sys.stderr)
            return 1
        path.write_bytes(data)
        print(f"{path.name}  {len(data) / 2**20:.1f} МиБ  sha256 ок")
    return 0


if __name__ == "__main__":
    sys.exit(main())
