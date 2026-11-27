#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""Готовит записи для замера распознавания узбекской речи.

Наборы (все открытые, закреплены коммитом):
  fleurs-uz   — FLEURS uz_uz, тест: чтение вслух, литературный узбекский;
  fleurs-ru   — FLEURS ru_ru, тест: русский — дообученная модель не должна
                разучиться понимать русский;
  podcast     — живая ташкентская речь из подкастов, русские слова вперемешку
                с узбекскими (расшифровка сделана моделью, не человеком);
  podcast-tel — те же записи, пропущенные через телефонный канал
                (8 кГц, G.711 µ-law, полоса 300–3400 Гц), как в веб-телефоне.

Пишет OUT/<набор>/<id>.wav (16 кГц, моно) и OUT/manifest.jsonl.
Использование: prepare.py OUT CACHE [N_FLEURS_UZ N_FLEURS_RU N_PODCAST]
"""
import csv, io, json, os, subprocess, sys, tarfile, urllib.request
from pathlib import Path

HF = "https://huggingface.co/datasets"
FLEURS = f"{HF}/google/fleurs/resolve/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data"
PODCAST = (f"{HF}/islomov/podcasts_tashkent_dialect_youtube_uzbek_speech_dataset/resolve/"
           "a397215c80771174cdc63ef83dce79bf8d6c06fd/data/train-00025-of-00026.parquet")

csv.field_size_limit(10**7)


def fetch(url, dest):
    dest = Path(dest)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            tmp.rename(dest)
            return dest
        except OSError as e:
            print(f"повтор {attempt + 1}: {url}: {e}", file=sys.stderr)
    raise SystemExit(f"не скачалось: {url}")


def ffmpeg(args):
    subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", *args], check=True)


def duration(wav):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(wav)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def to16k(src, dst):
    ffmpeg(["-i", str(src), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst)])


def telephone(src, dst):
    mid = dst.with_suffix(".tel.wav")
    ffmpeg(["-i", str(src), "-af", "highpass=f=300,lowpass=f=3400",
            "-ac", "1", "-ar", "8000", "-c:a", "pcm_mulaw", str(mid)])
    to16k(mid, dst)
    mid.unlink()


def fleurs(lang, name, n, out, cache):
    tsv = fetch(f"{FLEURS}/{lang}/test.tsv", cache / f"{lang}-test.tsv")
    picked, seen = {}, set()
    with open(tsv, encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            sid, fname, raw = row[0], row[1], row[2]
            if sid in seen:
                continue  # одна фраза — один голос, без повторов
            seen.add(sid)
            picked[fname] = raw
            if len(picked) >= n:
                break
    tar = fetch(f"{FLEURS}/{lang}/audio/test.tar.gz", cache / f"{lang}-test.tar.gz")
    rows = []
    (out / name).mkdir(parents=True, exist_ok=True)
    with tarfile.open(tar, "r:gz") as t:
        for m in t:
            base = os.path.basename(m.name)
            if not m.isfile() or base not in picked:
                continue
            raw = t.extractfile(m).read()
            src = cache / f"{name}-{base}"
            src.write_bytes(raw)
            dst = out / name / base
            to16k(src, dst)
            src.unlink()
            rows.append({"set": name, "id": base[:-4], "wav": str(dst.relative_to(out)),
                         "ref": picked[base], "lang": lang[:2], "dur": duration(dst)})
    rows.sort(key=lambda r: r["id"])
    return rows


def podcast(n, out, cache):
    import pyarrow.parquet as pq
    path = fetch(PODCAST, cache / "podcast-25.parquet")
    table = pq.read_table(path, columns=["id", "text"]).to_pylist()
    cand = sorted((r for r in table if 60 <= len(r["text"]) <= 400), key=lambda r: r["id"])
    step = max(1, len(cand) // (n * 2))  # по всему файлу, а не подряд из одного выпуска
    want = {r["id"] for r in cand[::step]}
    audio = pq.read_table(path, columns=["id", "audio", "text"])
    rows = []
    for name in ("podcast", "podcast-tel"):
        (out / name).mkdir(parents=True, exist_ok=True)
    for batch in audio.to_batches(max_chunksize=64):
        for r in batch.to_pylist():
            if r["id"] not in want or len(rows) >= 2 * n:
                continue
            ext = Path(r["audio"].get("path") or "x.wav").suffix or ".wav"
            src = cache / f"pod-{r['id']}{ext}"
            src.write_bytes(r["audio"]["bytes"])
            dst = out / "podcast" / f"{r['id']}.wav"
            to16k(src, dst)
            src.unlink()
            d = duration(dst)
            if not 3 <= d <= 30:
                dst.unlink()
                continue
            tel = out / "podcast-tel" / f"{r['id']}.wav"
            telephone(dst, tel)
            text = " ".join(r["text"].split())
            for name, wav in (("podcast", dst), ("podcast-tel", tel)):
                rows.append({"set": name, "id": r["id"], "wav": str(wav.relative_to(out)),
                             "ref": text, "lang": "uz", "dur": d})
        if len(rows) >= 2 * n:
            break
    return rows


def main():
    out, cache = Path(sys.argv[1]), Path(sys.argv[2])
    n_uz, n_ru, n_pod = (int(x) for x in (sys.argv[3:6] or (50, 30, 50)))
    out.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    rows = fleurs("uz_uz", "fleurs-uz", n_uz, out, cache)
    rows += fleurs("ru_ru", "fleurs-ru", n_ru, out, cache)
    rows += podcast(n_pod, out, cache)
    with open(out / "manifest.jsonl", "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    by = {}
    for r in rows:
        by.setdefault(r["set"], [0, 0.0])
        by[r["set"]][0] += 1
        by[r["set"]][1] += r["dur"]
    for k, (c, s) in by.items():
        print(f"{k}: {c} записей, {s / 60:.1f} мин")


if __name__ == "__main__":
    main()
