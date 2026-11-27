#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Сводит результаты моделей в одну таблицу (Markdown).

Использование: report.py DIR_WITH_JSON > results.md
"""
import json, sys
from pathlib import Path

SETS = [
    ("fleurs-uz", "Узбекский, чтение"),
    ("podcast", "Ташкентская речь, рус+узб"),
    ("podcast-tel", "То же через телефон"),
    ("fleurs-ru", "Русский, чтение"),
]


def cell(s, key):
    return "—" if s is None or s.get(key) is None else f"{s[key]}"


def main():
    res = [json.load(open(p, encoding="utf-8")) for p in sorted(Path(sys.argv[1]).glob("*.json"))]
    order = [m for m in ("box", "medium", "turbo") if any(r["model"] == m for r in res)]
    res.sort(key=lambda r: (order.index(r["model"]) if r["model"] in order else 99, r["model"]))
    first = next((r for r in res if r["sets"]), {"sets": {}})
    print("# Замер распознавания речи: узбекский и смешанная речь\n")
    print("Доля ошибок в словах (WER, %), меньше — лучше. В скобках — доля ошибок в буквах (CER).\n")
    print("| Модель | " + " | ".join(t for _, t in SETS) + " |")
    print("|---|" + "---|" * len(SETS))
    for r in res:
        row = [r.get("label", r["model"])]
        for k, _ in SETS:
            s = r["sets"].get(k)
            row.append("—" if not s else f"{s['wer']} ({s['cer']})")
        print("| " + " | ".join(row) + " |")
    print("\nСкорость на машине GitHub (4 ядра, не коробка): во сколько раз быстрее реального времени.\n")
    print("| Модель | Размер, МБ | " + " | ".join(t for _, t in SETS) + " |")
    print("|---|---|" + "---|" * len(SETS))
    for r in res:
        row = [r.get("label", r["model"]), str(r.get("size_mb", "—"))]
        row += [cell(r["sets"].get(k), "xrt") for k, _ in SETS]
        print("| " + " | ".join(row) + " |")
    print("\nЗаписей в наборах: " + ", ".join(
        f"{t} — {first['sets'][k]['n']} ({first['sets'][k]['audio_s'] / 60:.1f} мин)"
        for k, t in SETS if k in first["sets"]) + ".\n")
    print("## Примеры (ташкентская речь)\n")
    for r in res:
        ex = r["sets"].get("podcast", {}).get("examples", [])[:2]
        if not ex:
            continue
        print(f"**{r.get('label', r['model'])}**\n")
        for e in ex:
            print(f"- эталон: {e['ref'][:220]}\n  ответ: {e['hyp'][:220]}")
        print()


if __name__ == "__main__":
    main()
