#!/bin/bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Проверка factory-etc на раннере: первая загрузка заполняет /etc, новая
# версия докладывает только новые файлы, настройки коробки и выключенные
# юниты не трогает, та же версия — ничего не делает.
set -u
S=mkosi.extra/usr/lib/devuz/factory-etc
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: «$2», ждали «$3»"; fail=1; fi; }
export DEVUZ_FACTORY="$t/factory" DEVUZ_ETC="$t/etc" DEVUZ_OSREL="$t/os-release"
mkdir -p "$t/factory/devuz" "$t/factory/systemd/system/multi-user.target.wants" "$t/etc"
echo "a=1" >"$t/factory/devuz/a.conf"
ln -s /usr/lib/systemd/system/x.service "$t/factory/systemd/system/multi-user.target.wants/x.service"
echo IMAGE_VERSION=1 >"$t/os-release"

$S >/dev/null
check "первая загрузка: файл" "$(cat "$t/etc/devuz/a.conf")" "a=1"
check "первая загрузка: ссылка юнита" "$(readlink "$t/etc/systemd/system/multi-user.target.wants/x.service")" /usr/lib/systemd/system/x.service
check "метка — версия" "$(cat "$t/etc/.devuz-factory-etc")" 1

# Коробка живёт: свою настройку поменяли, юнит x выключили.
echo "a=своё" >"$t/etc/devuz/a.conf"
rm "$t/etc/systemd/system/multi-user.target.wants/x.service"
# Новая версия: в заготовке поменялся a.conf, появились b.conf, ссылка и новая ссылка юнита.
echo IMAGE_VERSION=2 >"$t/os-release"
echo "a=2" >"$t/factory/devuz/a.conf"; mkdir -p "$t/factory/new"; echo b >"$t/factory/new/b.conf"
ln -s b.conf "$t/factory/new/link"
ln -s /usr/lib/systemd/system/y.service "$t/factory/systemd/system/multi-user.target.wants/y.service"
out=$($S)
check "новая версия: новый файл" "$(cat "$t/etc/new/b.conf" 2>/dev/null)" b
check "новая версия: новая ссылка" "$(readlink "$t/etc/new/link" 2>/dev/null)" b.conf
check "своя настройка цела" "$(cat "$t/etc/devuz/a.conf")" "a=своё"
check "выключенный юнит не вернулся" "$([ -e "$t/etc/systemd/system/multi-user.target.wants/x.service" ] || [ -L "$t/etc/systemd/system/multi-user.target.wants/x.service" ] && echo вернулся || echo нет)" нет
check "ссылки юнитов из /etc не докладываем" "$([ -L "$t/etc/systemd/system/multi-user.target.wants/y.service" ] && echo есть || echo нет)" нет
check "в журнале — сколько новых" "$(grep -o 'новых файлов в /etc — [0-9]*' <<<"$out")" "новых файлов в /etc — 2"
check "метка — новая версия" "$(cat "$t/etc/.devuz-factory-etc")" 2
check "та же версия — тишина" "$($S)" ""

# Старая коробка: метка была пустым файлом (touch) — это «другая версия».
: >"$t/etc/.devuz-factory-etc"; rm "$t/etc/new/b.conf"
$S >/dev/null; check "старая метка: доложил" "$(cat "$t/etc/new/b.conf" 2>/dev/null)" b

[ "$fail" = 0 ] && echo "factory-etc: OK" || { echo "factory-etc: FAIL"; exit 1; }
