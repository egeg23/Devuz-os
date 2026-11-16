// SPDX-License-Identifier: LGPL-2.1-or-later
// Выбор, кто из очереди «Ядра» идёт к модели следующим. Отдельным файлом,
// чтобы проверять без коробки (tests/core-queue.test.js).
//
// Ступени: 0 live, 1 chat, 2 staff, 3 night. Старение: каждые age_s ожидания
// запрос поднимается на ступень, но не выше chat — live ничто не обгоняет.
// Так ночная задача днём не ждёт вечно: через age_s она как staff, через
// 2·age_s — как chat, и среди равных идёт тот, кто встал раньше.
// age_s = 0 — старение выключено.
"use strict";

const TOP_AGED = 1; // выше chat старение не поднимает

function rankNow(w, now, ageMs) {
  if (!ageMs || w.rank <= TOP_AGED) return w.rank;
  const steps = Math.floor((now - w.since) / ageMs);
  return Math.max(TOP_AGED, w.rank - steps);
}

// Номер следующего в waiting (или -1). w: { rank, seq (bigint), since (мс) }.
function pick(waiting, now, ageMs) {
  let best = -1, br = 0;
  for (let i = 0; i < waiting.length; i++) {
    const r = rankNow(waiting[i], now, ageMs);
    if (best < 0 || r < br || (r === br && waiting[i].seq < waiting[best].seq)) { best = i; br = r; }
  }
  return best;
}

module.exports = { pick, rankNow };
