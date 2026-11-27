#!/bin/bash
# SPDX-License-Identifier: LGPL-2.1-or-later
# Переводит дообученную модель Whisper с Hugging Face (формат transformers)
# в формат коробки (ggml whisper.cpp) и сжимает до того же числа бит, что
# стоят в коробке. Скрипт перевода — из whisper.cpp той же версии.
# Использование: convert.sh WHISPER_CPP_SRC OPENAI_WHISPER_SRC QUANTIZE REPO SHA QTYPE OUT
# QTYPE — q5_0, q5_1, q8_0 или f16 (без сжатия).
set -euo pipefail
src=$1 oai=$2 quantize=$3 repo=$4 sha=$5 qtype=$6 out=$7
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for f in config.json vocab.json added_tokens.json model.safetensors; do
  curl -fsSL --retry 4 -o "$work/$f" "https://huggingface.co/$repo/resolve/$sha/$f"
done
python3 "$src/models/convert-h5-to-ggml.py" "$work" "$oai" "$work" >"$work/convert.log" \
  || { tail -20 "$work/convert.log"; exit 1; }
if [ "$qtype" = f16 ]; then
  mv "$work/ggml-model.bin" "$out"   # без сжатия — чтобы увидеть, сколько стоит сжатие
else
  "$quantize" "$work/ggml-model.bin" "$out" "$qtype" >"$work/quantize.log" 2>&1 \
    || { tail -20 "$work/quantize.log"; exit 1; }
fi
ls -l "$out"
