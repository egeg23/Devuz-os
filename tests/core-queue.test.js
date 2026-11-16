// SPDX-License-Identifier: LGPL-2.1-or-later
// Очередь «Ядра» без коробки: кто идёт к модели следующим (core/queue.js).
// Запуск: node --test tests/core-queue.test.js (секунды, на раннере до сборки).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pick, rankNow } = require(path.join(__dirname, "../mkosi.extra/usr/lib/devuz/core/queue.js"));

const R = { live: 0, chat: 1, staff: 2, night: 3 };
let n = 0n;
const w = (prio, since) => ({ prio, rank: R[prio], since, seq: ++n });
const AGE = 60_000;
const order = (q, now, age = AGE) => {
  const left = [...q], out = [];
  while (left.length) out.push(left.splice(pick(left, now, age), 1)[0].prio);
  return out;
};

test("без ожидания — строго по ступеням, равные по очереди", () => {
  const q = [w("night", 0), w("staff", 0), w("live", 0), w("chat", 0)];
  assert.deepEqual(order(q, 1000), ["live", "chat", "staff", "night"]);
});

test("ночная, прождавшая age_s, обгоняет свежую staff", () => {
  const night = w("night", 0), staff = w("staff", 61_000);
  // Ступень сравнялась со staff, но ночная встала раньше.
  assert.equal(rankNow(night, 61_000, AGE), R.staff);
  assert.deepEqual(order([staff, night], 61_000), ["night", "staff"]);
});

test("через 2·age_s ночная — как chat и обгоняет свежий chat", () => {
  const night = w("night", 0); // встала раньше — и номер в очереди меньше
  assert.deepEqual(order([w("chat", 125_000), night], 125_000), ["night", "chat"]);
});

test("старение не обгоняет live: даже прождав час, ночная за live", () => {
  const night = w("night", 0);
  assert.equal(rankNow(night, 3_600_000, AGE), R.chat);
  assert.deepEqual(order([night, w("live", 3_600_000)], 3_600_000), ["live", "night"]);
});

test("дневной поток не морит ночную голодом", () => {
  // Модель отвечает за 10 с, каждые 10 с приходит новый staff. Ночная встала
  // в начале — без старения она не дождалась бы никогда.
  const q = [w("night", 0)];
  let served = -1;
  for (let t = 0; t < 300_000; t += 10_000) {
    q.push(w("staff", t));
    const [x] = q.splice(pick(q, t, AGE), 1);
    if (x.prio === "night") { served = t; break; }
  }
  assert.ok(served >= 0 && served <= 70_000, `ночная пошла на ${served} мс`);
});

test("age_s = 0 — старения нет", () => {
  const night = w("night", 0);
  assert.deepEqual(order([w("staff", 3_600_000), night], 3_600_000, 0), ["staff", "night"]);
});

test("пустая очередь — -1", () => { assert.equal(pick([], 0, AGE), -1); });
