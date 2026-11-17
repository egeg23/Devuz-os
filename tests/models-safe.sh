#!/bin/bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Проверка моделей на раннере (без загрузки образа, секунды): защита от
# отката номера выпуска и установка через <имя>.new с подменой каталога.
# Ключ подписи — новый на каждый прогон, во временном каталоге, никуда не
# сохраняется.
set -u
cd "$(dirname "$0")/.." || exit 1
V=$PWD/mkosi.extra/usr/lib/devuz/models-verify
I=$PWD/mkosi.extra/usr/lib/devuz/models-install
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

export GNUPGHOME="$t/gnupg"; mkdir -m 700 "$GNUPGHOME"
gpg --batch -q --passphrase '' --quick-gen-key "DevUz runner models <noreply@devuz.invalid>" ed25519 sign 1d 2>/dev/null
gpg --export >"$t/models.gpg"
export DEVUZ_MODELS_ROOT="$t/models" DEVUZ_MODELS_STAMPS="$t/stamps" \
       DEVUZ_MODELS_RELEASES="$t/release" DEVUZ_MODELS_KEYRING="$t/models.gpg" \
       DEVUZ_MODELS_VERIFY="$V"

# Пакет модели: веса (свои байты на выпуск) и подписанный манифест.
pack() { # каталог выпуск [строки-манифеста-вместо-release]
    local d=$1 rel=$2 relline=${3-"release: $2"}
    mkdir -p "$d"; head -c 65536 /dev/urandom >"$d/w.gguf"
    printf 'name: tiny\n%sversion: %s\nlicense: MIT\nformat: gguf\nsha256 %s %s w.gguf\n' \
        "${relline:+$relline$'\n'}" "$rel" "$(sha256sum <"$d/w.gguf" | cut -d' ' -f1)" "$(stat -c %s "$d/w.gguf")" >"$d/MANIFEST"
    gpg --batch -q --detach-sign --output "$d/MANIFEST.sig" "$d/MANIFEST"
}
pack "$t/r5" 5; pack "$t/r7" 7; pack "$t/r3" 3; pack "$t/r7b" 7
pack "$t/norel" 9 ""

# 1. Первая установка, потом новее.
out=$("$I" "$t/r5") && [ -d "$t/models/tiny" ] && [ "$(cat "$t/release/tiny")" = 5 ] &&
    ok "первая установка: $out" || bad "первая установка: $out"
cmp -s "$t/r5/w.gguf" "$t/models/tiny/w.gguf" || bad "веса r5 не на месте"
# Сервер модели держит старый файл открытым (как mmap) — после подмены он
# должен читать целые старые веса, а не смесь.
exec 8<"$t/models/tiny/w.gguf"
ino_old=$(stat -c %i "$t/models/tiny/w.gguf")
out=$("$I" "$t/r7") && [ "$(cat "$t/release/tiny")" = 7 ] && cmp -s "$t/r7/w.gguf" "$t/models/tiny/w.gguf" &&
    ok "обновление 5 → 7: $out" || bad "обновление 5 → 7: $out"
cmp -s "$t/r5/w.gguf" /dev/fd/8 && ok "открытый старый файл цел после подмены" || bad "старый открытый файл испорчен"
exec 8<&-
[ "$(stat -c %i "$t/models/tiny/w.gguf")" != "$ino_old" ] && ok "новые веса — другой файл, не переписанный старый" || bad "старый файл переписан на месте"
[ ! -e "$t/models/tiny.new" ] && ok "<имя>.new убран после подмены" || bad "<имя>.new остался"

# 2. Откат: старый подписанный манифест — отказ, рабочая модель не тронута.
if out=$("$I" "$t/r3" 2>&1); then bad "откат 7 → 3 принят: $out"
else
    case "$out" in *"откат: выпуск манифеста 3 меньше уже принятого 7"*) ok "откат 7 → 3 отвергнут: ${out##*ERROR }" ;;
        *) bad "откат отвергнут не по номеру выпуска: $out" ;; esac
fi
cmp -s "$t/r7/w.gguf" "$t/models/tiny/w.gguf" && [ ! -e "$t/models/tiny.new" ] &&
    ok "после отказа — рабочая модель 7, .new нет" || bad "после отказа модель испорчена"
# Тот же откат прямо в каталоге (подменили файлы руками) — проверка при загрузке.
rm -rf "$t/models/tiny"; cp -a "$t/r3" "$t/models/tiny"
if out=$("$V" --check tiny 2>&1); then bad "models-verify принял старый манифест: $out"
else case "$out" in *откат*) ok "models-verify: старый манифест в каталоге — отказ" ;; *) bad "models-verify: $out" ;; esac; fi
# Такой же номер — повтор, можно.
out=$("$I" "$t/r7b") && ok "тот же выпуск 7 — повтор принят" || bad "повтор выпуска 7 отвергнут: $out"
out=$("$V" --check tiny) && ok "проверка после повтора: $(printf "%s\n" "$out" | head -n1)" || bad "проверка после повтора: $out"
case "$out" in *штамп*) ok "штамп из проверки .new годен после переименования" ;; *) bad "после подмены хеши считались заново: $out" ;; esac

# 3. Без release: — отказ; битая подпись в .new — рабочая модель цела.
out=$("$I" "$t/norel" 2>&1) && bad "манифест без release: принят" ||
    { case "$out" in *release:*) ok "манифест без release: — отказ" ;; *) bad "без release: — $out" ;; esac; }
pack "$t/r9" 9; echo "# лишнее" >>"$t/r9/MANIFEST"
out=$("$I" "$t/r9" 2>&1) && bad "битая подпись принята" ||
    { case "$out" in *подпись*) ok "битая подпись в .new — отказ" ;; *) bad "битая подпись: $out" ;; esac; }
cmp -s "$t/r7b/w.gguf" "$t/models/tiny/w.gguf" && [ "$(cat "$t/release/tiny")" = 7 ] &&
    ok "рабочая модель и номер выпуска не тронуты" || bad "рабочая модель тронута"
# Испорченная запись номера выпуска — не «ноль», а отказ (проверить руками).
echo мусор >"$t/release/tiny"
out=$("$V" --check tiny 2>&1) && bad "испорченная запись выпуска принята" || ok "испорченная запись выпуска — отказ"

[ "$fail" = 0 ] && echo "models-safe: OK" || { echo "models-safe: FAIL"; exit 1; }
