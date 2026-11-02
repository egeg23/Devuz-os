#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Портит раздел /usr (слот A) в образе — для проверки dm-verity.

Перезаписывает 64 байта суперблока erofs (смещение 1024 от начала раздела).
С dm-verity чтение этого блока должно дать ошибку, и система не загрузится.

Запуск: corrupt-usr.py <образ.raw>
"""
import json
import subprocess
import sys

USR_X86_64 = "8484680C-9521-48C6-9C11-B0720656F69E"


def main() -> int:
    image = sys.argv[1]
    table = json.loads(subprocess.run(["sfdisk", "--json", image], check=True,
                                      capture_output=True, text=True).stdout)["partitiontable"]
    sector = int(table.get("sectorsize", 512))
    usr = next(p for p in table["partitions"]
               if p["type"].upper() == USR_X86_64 and p.get("name") != "_empty")
    offset = int(usr["start"]) * sector + 1024
    with open(image, "r+b") as f:
        f.seek(offset)
        f.write(b"\xde\xad\xbe\xef" * 16)
    print(f"Испорчено 64 байта в разделе «{usr.get('name')}» по смещению {offset}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
