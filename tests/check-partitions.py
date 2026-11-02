#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Проверка разметки готового образа по `sfdisk --json`.

Сверяет типы разделов (GUID по спецификации Discoverable Partitions) и
ярлыки: ESP, /usr версии A с ярлыком devuz_<версия>, пустой слот /usr
с ярлыком _empty и временный root.

Запуск: check-partitions.py <образ.raw> <версия>
"""
import json
import subprocess
import sys

ESP = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"
USR_X86_64 = "8484680C-9521-48C6-9C11-B0720656F69E"
ROOT_X86_64 = "4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709"


def main() -> int:
    image, version = sys.argv[1], sys.argv[2]
    out = subprocess.run(["sfdisk", "--json", image], check=True, capture_output=True, text=True).stdout
    parts = json.loads(out)["partitiontable"]["partitions"]

    got = [(p["type"].upper(), p.get("name", ""), int(p["size"]) * 512) for p in parts]
    for t, name, size in got:
        print(f"  {t}  {name or '-':<28} {size / 2**20:8.0f} МиБ")

    expected = [
        (ESP, None),
        (USR_X86_64, f"devuz_{version}"),
        (USR_X86_64, "_empty"),
        (ROOT_X86_64, None),
    ]

    errors = []
    if len(got) != len(expected):
        errors.append(f"разделов {len(got)}, ожидалось {len(expected)}")
    for i, ((t, name, _), (et, ename)) in enumerate(zip(got, expected), 1):
        if t != et:
            errors.append(f"раздел {i}: тип {t}, ожидался {et}")
        if ename is not None and name != ename:
            errors.append(f"раздел {i}: ярлык «{name}», ожидался «{ename}»")

    if len(got) >= 3 and got[1][2] != got[2][2]:
        errors.append(f"слоты /usr разного размера: {got[1][2]} и {got[2][2]}")

    if errors:
        for e in errors:
            print(f"ОШИБКА: {e}")
        return 1

    print("Разметка совпадает с ожидаемой.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
