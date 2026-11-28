#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Прогоняет наборы замера через GigaAM Multilingual v2 (MIT) — не Whisper, в
коробку пока не входит; здесь только замер точности. Язык не подсказываем
(`auto`): в смешанной речи его заранее никто не знает.

Модель грузится вместе с кодом её авторов (trust_remote_code), поэтому
запускается только в отдельной задаче Actions без секретов и прав записи,
версия закреплена коммитом (решение владельца, 28.11.2026: «начни с гигаАм»).

Использование: gigaam.py DATA RUN full|stream [ЗАДЕРЖКА_МС]
  full   — запись целиком;
  stream — потоковый режим кусками по 0,5 с, как пойдёт живой звонок.
Пишет то же, что tools/stt-bench/run.sh: RUN/<набор>/<id>.txt, RUN/<набор>.time.
"""
import json, sys, time
from pathlib import Path

import torch
from transformers import AutoModel

REPO = "ai-sage/GigaAM-Multilingual-v2"
REV = "c21483b5e185ff32f6fb2e2c801f92f4e7fbfee8"  # ветка rnnt


def main():
    data, run, mode = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    ctx = int(sys.argv[4]) if len(sys.argv) > 4 else 640
    model = AutoModel.from_pretrained(REPO, revision=REV, trust_remote_code=True,
                                      language="auto", device="cpu").eval()
    sets = {}
    for line in open(data / "manifest.jsonl", encoding="utf-8"):
        r = json.loads(line)
        sets.setdefault(r["set"], []).append(r)
    for name, rows in sets.items():
        (run / name).mkdir(parents=True, exist_ok=True)
        start, failed = time.time(), 0
        for r in rows:
            wav = str(data / r["wav"])
            try:
                with torch.inference_mode():
                    if mode == "full":
                        text = model.transcribe(wav)["e2e"].text
                    else:
                        stream = model.create_stream(future_context_ms=ctx)
                        text = ""
                        for piece in model.model.prepare_wav(wav)[0][0].split(8000):
                            text += stream.transcribe_partial(piece)["e2e"].text
                        text += stream.flush()["e2e"].text
            except Exception as e:  # одна запись не должна ронять весь прогон
                failed += 1
                if failed <= 3:
                    print(f"::warning::{name}/{r['id']}: {type(e).__name__}: {e}", flush=True)
                continue
            (run / name / f"{r['id']}.txt").write_text(text, encoding="utf-8")
        (run / f"{name}.time").write_text(str(round(time.time() - start, 1)))
        print(f"{name}: {len(rows) - failed} из {len(rows)} за {time.time() - start:.0f} с", flush=True)
        if failed == len(rows):
            raise SystemExit(f"{name}: не распознано ни одной записи")


if __name__ == "__main__":
    main()
