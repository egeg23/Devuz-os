#!/bin/bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Службы DevUz включаются ссылками в /usr/lib/systemd/system/<цель>.wants/,
# а не только через preset. Preset срабатывает один раз, при сборке образа,
# и пишет ссылки в /etc. А /etc на коробке после первой загрузки живёт своей
# жизнью и обновлением не меняется. Поэтому служба, добавленная в новой версии
# ОС, на уже стоящей коробке осталась бы выключенной. /usr приходит с каждым
# обновлением целиком, и ссылки в нём включают службу и на старых коробках.
#
# Проверка: у каждой нашей службы и таймера с [Install] WantedBy=… есть
# ссылка в /usr на каждую цель. Шаблоны (…@.service) не включаются так.
set -euo pipefail
cd "$(dirname "$0")/.."
dir=mkosi.extra/usr/lib/systemd/system
fail=0
for u in "$dir"/devuz-*.service "$dir"/devuz-*.timer; do
    [ -f "$u" ] || continue
    name=$(basename "$u")
    case "$name" in *@.*) continue ;; esac
    for t in $(sed -n 's/^WantedBy=//p' "$u"); do
        l="$dir/$t.wants/$name"
        if [ ! -L "$l" ] || [ "$(readlink "$l")" != "../$name" ]; then
            echo "::error::$name: нет ссылки $t.wants/$name → ../$name (на старых коробках служба не включится)"
            fail=1
        fi
    done
done
[ "$fail" = 0 ] && echo "UNIT-LINKS ok: все службы DevUz включены ссылками в /usr"
exit "$fail"
