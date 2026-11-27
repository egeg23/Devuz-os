#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Считает ошибки распознавания по наборам.

WER — доля ошибок в словах (замены + пропуски + лишние, к числу слов в
эталоне), CER — то же по буквам. Перед сравнением и эталон, и ответ
приводятся к одному виду: строчные, кириллица — латиницей по узбекскому
образцу (модель пишет узбекский то кириллицей, то латиницей, и это не
ошибка распознавания), без знаков препинания и апострофов (o'/oʻ/o’
пишут по-разному).

Использование: score.py DATA RUN MODEL [ПОДПИСЬ] [ФАЙЛ_МОДЕЛИ] > result.json
  DATA — папка prepare.py (manifest.jsonl), RUN — папка с <set>/<id>.txt
  и <set>.time (секунды на набор).
"""
import json, re, sys, unicodedata
from pathlib import Path

CYR = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "j",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "x", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "sh", "ъ": "", "ы": "i", "ь": "", "э": "e", "ю": "yu",
    "я": "ya", "ў": "o", "қ": "q", "ғ": "g", "ҳ": "h",
}


def norm(text):
    t = unicodedata.normalize("NFC", text).lower()
    t = "".join(CYR.get(c, c) for c in t)
    t = re.sub(r"[ʻʼ’‘`'´]", "", t)
    t = re.sub(r"[^\w\s]|_", " ", t)
    return t.split()


def edits(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def main():
    data, run, model = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    sets = {}
    for line in open(data / "manifest.jsonl", encoding="utf-8"):
        r = json.loads(line)
        hyp_file = run / r["set"] / f"{r['id']}.txt"
        hyp = hyp_file.read_text(encoding="utf-8", errors="replace") if hyp_file.exists() else ""
        ref_w, hyp_w = norm(r["ref"]), norm(hyp)
        s = sets.setdefault(r["set"], {"n": 0, "words": 0, "wedits": 0, "chars": 0,
                                       "cedits": 0, "audio_s": 0.0, "missing": 0,
                                       "examples": []})
        s["n"] += 1
        s["audio_s"] += r["dur"]
        s["missing"] += not hyp_file.exists()
        s["words"] += len(ref_w)
        s["wedits"] += edits(ref_w, hyp_w)
        ref_c, hyp_c = " ".join(ref_w), " ".join(hyp_w)
        s["chars"] += len(ref_c)
        s["cedits"] += edits(ref_c, hyp_c)
        if len(s["examples"]) < 3:
            s["examples"].append({"id": r["id"], "ref": r["ref"], "hyp": " ".join(hyp.split())})
    for name, s in sets.items():
        s["wer"] = round(100 * s["wedits"] / max(1, s["words"]), 1)
        s["cer"] = round(100 * s["cedits"] / max(1, s["chars"]), 1)
        t = run / f"{name}.time"
        s["wall_s"] = float(t.read_text()) if t.exists() else None
        s["xrt"] = round(s["audio_s"] / s["wall_s"], 2) if s["wall_s"] else None
    res = {"model": model, "label": sys.argv[4] if len(sys.argv) > 4 else model, "sets": sets}
    if len(sys.argv) > 5:
        res["size_mb"] = round(Path(sys.argv[5]).stat().st_size / 2**20)
    json.dump(res, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
