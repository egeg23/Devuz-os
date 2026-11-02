#!/bin/bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Тест загрузки: запускает собранный образ в QEMU через `mkosi vm`
# (одноразовая копия, Ephemeral=yes; консоль native — read-only в v27.1
# требует systemd-pty-forward, а его нет в systemd 257 из trixie), ждёт строк DEVUZ-READY и
# DEVUZ-SELFTEST OK, проверяет версии.
#
# Переменные:
#   TEST_TIMEOUT   — сколько секунд ждать (по умолчанию 900);
#   EXTRA_CMDLINE  — добавить в строку ядра (для проверки «сломанного» образа);
#   MKOSI_ARGS     — дополнительные опции mkosi (каталоги вывода и т.п.);
#   EXPECT_VERSION — ожидаемая версия образа (если задана).
set -uo pipefail

TEST_TIMEOUT="${TEST_TIMEOUT:-900}"
LOG="${LOG:-boot.log}"
MIN_KERNEL="6.18.4"
MIN_SYSTEMD="257"

summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$*" >>"$GITHUB_STEP_SUMMARY"; fi; echo "$*"; }

start=${EPOCHREALTIME/[.,]/}
ready_at=""

# Каждую строку консоли помечаем временем от старта, чтобы посчитать
# время до готовности снаружи машины.
# shellcheck disable=SC2086
timeout --foreground "$TEST_TIMEOUT" \
    mkosi ${MKOSI_ARGS:-} \
        --ephemeral=yes \
        --console=native \
        --kernel-command-line-extra="systemd.wants=devuz-selftest.service ${EXTRA_CMDLINE:-}" \
        vm </dev/null 2>&1 |
while IFS= read -r line; do
    now=${EPOCHREALTIME/[.,]/}
    d=$(( (now - start) / 10000 ))
    printf '[%4d.%02d] %s\n' $((d / 100)) $((d % 100)) "$line"
done | tee "$LOG.raw"
rc=${PIPESTATUS[0]}

# Убираем цветовые коды и возвраты каретки.
sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' -e 's/\r//g' "$LOG.raw" >"$LOG"

fail=0
err() { echo "::error::$*"; summary "- ❌ $*"; fail=1; }

summary "## Тест загрузки"
if [ "$rc" -eq 124 ]; then
    err "таймаут ${TEST_TIMEOUT} с: машина не дошла до конца самопроверки"
elif [ "$rc" -ne 0 ]; then
    err "mkosi vm завершился с кодом $rc"
fi

if grep -qiE 'emergency mode|Reached target .*Emergency|emergency\.target' "$LOG"; then
    err "система ушла в аварийный режим (emergency)"
fi
if grep -qE 'Failed to start' "$LOG"; then
    err "при загрузке не запустились службы:"
    grep -E 'Failed to start' "$LOG" | sed 's/^/    /'
fi

ready_line=$(grep -m1 -oE 'DEVUZ-READY .*' "$LOG" || true)
if [ -z "$ready_line" ]; then
    err "нет строки DEVUZ-READY"
else
    summary "- \`$ready_line\`"
    ready_at=$(grep -m1 'DEVUZ-READY' "$LOG" | sed -E 's/^\[ *([0-9.]+)\].*/\1/')
    guest_up=$(echo "$ready_line" | sed -nE 's/.*uptime=([0-9.]+)s.*/\1/p')
    summary "- Время до готовности: ${guest_up:-?} с от старта ядра, ${ready_at:-?} с от запуска QEMU (вместе с прошивкой и загрузчиком)"
fi

if ! grep -q 'DEVUZ-SELFTEST OK' "$LOG"; then
    err "нет строки DEVUZ-SELFTEST OK"
    grep -E 'DEVUZ-SELFTEST (FAIL|ERROR|FAILED_UNIT)' "$LOG" | sed 's/^/    /'
fi

field() { grep -m1 -oE "DEVUZ-SELFTEST $1 .*" "$LOG" | cut -d' ' -f3- || true; }
kernel=$(field KERNEL)
systemd=$(field SYSTEMD)
image_id=$(field IMAGE_ID)
image_version=$(field IMAGE_VERSION)
build_id=$(field BUILD_ID)
usr_fs=$(field USR_FS)

summary "- Ядро: \`${kernel:-?}\`, systemd: \`${systemd:-?}\`, /usr: \`${usr_fs:-?}\`"
summary "- IMAGE_ID=\`${image_id:-?}\` IMAGE_VERSION=\`${image_version:-?}\` BUILD_ID=\`${build_id:-?}\`"

# Версия ядра вида 7.2.11+bpo-amd64 → сравниваем числовую часть.
kver=$(echo "$kernel" | grep -oE '^[0-9]+(\.[0-9]+)*' || true)
if [ -n "$kver" ]; then
    systemd-analyze compare-versions "$kver" ge "$MIN_KERNEL" ||
        err "ядро $kver старше $MIN_KERNEL"
elif [ -n "$ready_line" ]; then
    err "не удалось прочитать версию ядра"
fi
if [ -n "$systemd" ]; then
    systemd-analyze compare-versions "$systemd" ge "$MIN_SYSTEMD" ||
        err "systemd $systemd старше $MIN_SYSTEMD"
elif [ -n "$ready_line" ]; then
    err "не удалось прочитать версию systemd"
fi
if grep -qE 'command not found' "$LOG"; then
    err "в образе не хватает программ:"
    grep -E 'command not found' "$LOG" | sed 's/^/    /'
fi
if [ -n "$ready_line" ]; then
    [ "$image_id" = "devuz" ] || err "IMAGE_ID=«$image_id», ожидался devuz"
    echo "$image_version" | grep -qE '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$' ||
        err "IMAGE_VERSION=«$image_version» не в формате ГГГГ.ММ.ДД.N"
    if [ -n "${EXPECT_VERSION:-}" ] && [ "$image_version" != "$EXPECT_VERSION" ]; then
        err "IMAGE_VERSION=«$image_version», ожидалась $EXPECT_VERSION"
    fi
    [ "$usr_fs" = "erofs" ] || err "/usr не на erofs"
fi

if [ "$fail" -eq 0 ]; then
    summary "- ✅ Тест загрузки пройден"
fi
exit "$fail"
