#!/bin/bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Проверка reboot-guard на раннере (без загрузки образа): счёт неудач подряд,
# паузы (три по 2 мин, дальше вдвое до часа), обнуление, переменная EFI в
# формате прошивки и запасной файл, когда EFI нет.
set -u
G=mkosi.extra/usr/lib/devuz/reboot-guard
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: «$2», ждали «$3»"; fail=1; fi; }
export DEVUZ_GUARD_DRY=1 DEVUZ_GUARD_VAR="$t/efi/DevuzFailedBoots-x" DEVUZ_GUARD_FILE="$t/var/failed-boots"
mkdir -p "$t/efi"

check "сначала ноль" "$($G get)" 0
want=(120 120 120 240 480 960 1920 3600 3600)
for i in "${!want[@]}"; do
    d=$($G fail тест | sed -n 's/^DRY delay=//p')
    check "неудача №$((i + 1)) — пауза" "$d" "${want[$i]}"
done
check "счёт" "$($G get)" 9
check "формат EFI: атрибуты 7 и LE32" "$(od -An -tu1 "$DEVUZ_GUARD_VAR" | tr -s ' ' | sed 's/^ //;s/ $//')" "7 0 0 0 9 0 0 0"
$G fail тест | grep -q "прошлая версия тоже не загружается" && echo "ok   с 4-й — строка «нужен человек»" || { echo "FAIL нет строки «нужен человек»"; fail=1; }
check "очень много неудач — не больше часа" "$(printf '\x07\x00\x00\x00\xe8\x03\x00\x00' >"$DEVUZ_GUARD_VAR"; $G fail тест | sed -n 's/^DRY delay=//p')" 3600
$G ok >/dev/null; check "удачная загрузка — ноль" "$($G get)" 0
before=$(stat -c %Y "$DEVUZ_GUARD_VAR"); sleep 1; $G ok >/dev/null
check "ноль не переписываем" "$(stat -c %Y "$DEVUZ_GUARD_VAR")" "$before"

# Без EFI — запасной файл.
export DEVUZ_GUARD_VAR="$t/нет-efi/DevuzFailedBoots-x"
$G fail тест >/dev/null; $G fail тест >/dev/null
check "без EFI — файл" "$(cat "$DEVUZ_GUARD_FILE")" 2
echo мусор >"$DEVUZ_GUARD_FILE"; check "мусор в файле — ноль" "$($G get)" 0

[ "$fail" = 0 ] && echo "reboot-guard: OK" || { echo "reboot-guard: FAIL"; exit 1; }
