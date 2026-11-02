#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Раскладывает собранную версию образа для systemd-sysupdate.

Берёт из каталога вывода mkosi разделы usr, usr-verity, usr-verity-sig и UKI
версии <версия>, кладёт их в <каталог сервера> под именами, которые ждут
/usr/lib/sysupdate.d/*.transfer (devuz_<версия>_<UUID раздела>.<тип>.raw и
devuz_<версия>.efi), и пишет SHA256SUMS.

UUID разделов нужны в именах: systemd находит /usr по UUID, выведенным из
usrhash=, и sysupdate должен создать разделы ровно с такими UUID.

Запуск: publish-update.py <каталог вывода mkosi> <версия> <каталог сервера>
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys

TYPES = {
    "8484680C-9521-48C6-9C11-B0720656F69E": ("usr", ""),
    "77FF5F63-E7B6-4633-ACF4-1565B864C0E6": ("usr-verity", "_verity"),
    "E7BB33FB-06CF-4E81-8273-E543B413E2E2": ("usr-verity-sig", "_verity_sig"),
}


def main() -> int:
    out, version, serve = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
    serve.mkdir(parents=True, exist_ok=True)
    image = out / f"devuz_{version}.raw"
    parts = json.loads(subprocess.run(["sfdisk", "--json", str(image)], check=True,
                                      capture_output=True, text=True).stdout)["partitiontable"]["partitions"]

    published = []
    for p in parts:
        kind = TYPES.get(p["type"].upper())
        if not kind or p.get("name") != f"devuz_{version}{kind[1]}":
            continue
        src = out / f"devuz_{version}.{kind[0]}.raw"
        dst = serve / f"devuz_{version}_{p['uuid'].lower()}.{kind[0]}.raw"
        os.link(src, dst) if src.stat().st_dev == serve.stat().st_dev else dst.write_bytes(src.read_bytes())
        published.append(dst)

    if len(published) != 3:
        print(f"ОШИБКА: нашлось {len(published)} разделов версии {version} из 3", file=sys.stderr)
        return 1

    uki = serve / f"devuz_{version}.efi"
    uki.write_bytes((out / f"devuz_{version}.efi").read_bytes())
    published.append(uki)

    with open(serve / "SHA256SUMS", "a") as sums:
        for f in published:
            h = hashlib.sha256()
            with open(f, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            sums.write(f"{h.hexdigest()}  {f.name}\n")
            print(f"{f.name}  {f.stat().st_size / 2**20:.1f} МиБ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
