#!/bin/bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Прогоняет все наборы через одну модель: whisper-cli той же версии, что в
# коробке, настройки по умолчанию (как у whisper-server в коробке).
# Использование: run.sh WHISPER_CLI MODEL DATA RUN
# Пишет RUN/<набор>/<id>.txt и RUN/<набор>.time (секунды на весь набор).
set -euo pipefail
cli=$1 model=$2 data=$3 run=$4
threads=$(nproc)
mkdir -p "$run"
for set in $(python3 -c 'import json,sys
seen=[]
for l in open(sys.argv[1]):
    s=json.loads(l)["set"]
    if s not in seen: seen.append(s); print(s)' "$data/manifest.jsonl"); do
  lang=$(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    r=json.loads(l)
    if r["set"]==sys.argv[2]: print(r["lang"]); break' "$data/manifest.jsonl" "$set")
  mkdir -p "$run/$set"
  args=()
  for f in "$data/$set"/*.wav; do args+=(-f "$f"); done
  start=$(date +%s.%N)
  "$cli" -m "$model" -l "$lang" -t "$threads" -nt -np -otxt "${args[@]}" >/dev/null 2>"$run/$set.log" \
    || { echo "::warning::$set: whisper-cli завершился с ошибкой"; tail -5 "$run/$set.log"; }
  end=$(date +%s.%N)
  python3 -c "import sys;print(round(float(sys.argv[2])-float(sys.argv[1]),1))" "$start" "$end" >"$run/$set.time"
  for t in "$data/$set"/*.wav.txt; do
    [ -e "$t" ] || continue
    b=$(basename "$t" .wav.txt)
    mv "$t" "$run/$set/$b.txt"
  done
  echo "$set ($lang): $(ls "$run/$set" | wc -l) ответов за $(cat "$run/$set.time") с"
done
