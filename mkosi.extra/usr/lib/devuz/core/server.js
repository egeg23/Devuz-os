// SPDX-License-Identifier: LGPL-2.1-or-later
// «Ядро» DevUz — шлюз моделей и первый кусок API платформы (v1).
// Node без пакетов. Слушает 127.0.0.1:8090 и сокет /run/devuz/core/core.sock
// (сокет — для приложений в песочнице без сети, недели 6–7).
//
// API v1 (совместим с OpenAI):
//   GET  /v1/health            — живо ли «Ядро» и длина очередей (без токена);
//   GET  /v1/models[/<id>]     — задачи, доступные этому токену;
//   POST /v1/chat/completions  — model = задача («chat», «chat-uz», «code»…),
//                                 «Ядро» само выбирает модель по таблице коробки.
// Токен приложения — Authorization: Bearer <токен>. На коробке хранится
// только sha256 токена: /etc/devuz/core/apps.d/<приложение>.json
//   {"token_sha256": "...", "tasks": ["chat"], "priority": "staff"}
// Приоритеты очереди: live > chat > staff > night. Приложение может только
// понизить свой приоритет (заголовок X-DevUz-Priority), но не повысить.
// Очередь на бэкенд ограничена (max_queue): лишний запрос сразу получает 429
// с Retry-After, а не ждёт бесконечно — коробка не «тормозит у всех».
// Учёт: /var/lib/devuz/core/usage-ГГГГ-ММ-ДД.jsonl — кто, задача, токены,
// время. Текст запросов и ответов не пишется никуда.
// Таблица задач: /etc/devuz/core/tasks.json, иначе tasks.<класс коробки>.json
// (/run/devuz/box/box.json, devuz-box-class), иначе tasks.json. Задачи нет
// на этой модели коробки — 404 с подсказкой, на какой она есть.
// Облако выключено: задачи ведут только на адреса из таблицы коробки.
"use strict";
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TASKS_ETC = "/etc/devuz/core/tasks.json";
const TASKS_USR_DIR = "/usr/share/devuz/core";
const BOX_JSON = "/run/devuz/box/box.json";
const APPS_DIR = "/etc/devuz/core/apps.d";
const USAGE_DIR = "/var/lib/devuz/core";
const SOCK = "/run/devuz/core/core.sock";
const PRIORITIES = ["live", "chat", "staff", "night"];
const BODY_LIMIT = 2 << 20; // 2 МБ: текстовым задачам больше не нужно
const USAGE_BUF_LIMIT = 1 << 20; // буферизуем обычный ответ для учёта не больше 1 МБ

function log(...a) { console.log("DEVUZ-CORE", ...a); }

// --- настройки: битый файл не подменяется молча другим
function checkTasks(t) {
  if (!t || typeof t !== "object" || !t.backends || typeof t.backends !== "object" || !t.tasks || typeof t.tasks !== "object")
    throw new Error("нужны объекты backends и tasks");
  const backends = new Map();
  for (const [name, b] of Object.entries(t.backends)) {
    if (!b || typeof b.url !== "string") throw new Error(`у бэкенда «${name}» нет url`);
    const u = new URL(b.url); // бросит на кривом адресе
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`бэкенд «${name}»: только http или https`);
    const int = (v, d, min) => (v === undefined ? d : Number.isInteger(v) && v >= min ? v : NaN);
    const be = { url: b.url.replace(/\/+$/, ""), concurrency: int(b.concurrency, 1, 1), maxQueue: int(b.max_queue, 32, 0), timeoutMs: int(b.timeout_s, 120, 1) * 1000, maxWaitMs: int(b.max_wait_s, 300, 1) * 1000 };
    if ([be.concurrency, be.maxQueue, be.timeoutMs, be.maxWaitMs].some(Number.isNaN)) throw new Error(`бэкенд «${name}»: concurrency, max_queue, timeout_s, max_wait_s — целые числа`);
    backends.set(name, be);
  }
  const tasks = new Map();
  for (const [name, r] of Object.entries(t.tasks)) {
    if (!r || !backends.has(r.backend) || typeof r.model !== "string") throw new Error(`задача «${name}»: нет такого бэкенда или model`);
    tasks.set(name, { backend: r.backend, model: r.model });
  }
  const unavailable = new Map();
  for (const [name, why] of Object.entries(t.unavailable || {})) if (typeof why === "string") unavailable.set(name, why);
  return { backends, tasks, unavailable };
}

// Класс коробки (devuz-box-class: lite / pro / jarvis…). Своя таблица задач
// на класс — tasks.<класс>.json; нет такой — общая tasks.json.
function boxClass() {
  try {
    const c = JSON.parse(fs.readFileSync(BOX_JSON, "utf8")).class;
    return typeof c === "string" && /^[a-z-]{2,20}$/.test(c) ? c : null;
  } catch { return null; }
}

function loadTasks(prev) {
  // /etc (таблица этой коробки) главнее /usr (заводская). Если в /etc файл
  // есть, но битый — заводскую НЕ берём: оставляем прежнюю таблицу, а при
  // старте работаем без задач и громко пишем в журнал.
  const cls = boxClass();
  const byClass = cls && path.join(TASKS_USR_DIR, `tasks.${cls}.json`);
  const f = fs.existsSync(TASKS_ETC) ? TASKS_ETC : byClass && fs.existsSync(byClass) ? byClass : path.join(TASKS_USR_DIR, "tasks.json");
  try {
    const t = checkTasks(JSON.parse(fs.readFileSync(f, "utf8")));
    t.file = f; t.boxClass = cls || "неизвестен";
    log("таблица задач", f, "класс коробки", t.boxClass);
    return t;
  } catch (e) {
    log("ОШИБКА в", f, "—", e.message, prev ? "(оставляю прежнюю таблицу)" : "(задач нет, пока файл не исправят)");
    return prev || { backends: new Map(), tasks: new Map(), unavailable: new Map(), file: f, boxClass: cls || "неизвестен" };
  }
}

function loadApps(prev) {
  const apps = new Map();
  const prevById = new Map([...(prev || new Map()).entries()].map(([h, a]) => [a.id, [h, a]]));
  let names = [];
  try { names = fs.readdirSync(APPS_DIR).filter((n) => n.endsWith(".json")); } catch { return apps; }
  const owner = new Map(); // отпечаток токена -> файл
  const dups = new Set();
  for (const n of names.sort()) {
    const id = n.slice(0, -5);
    try {
      const a = JSON.parse(fs.readFileSync(path.join(APPS_DIR, n), "utf8"));
      if (!a || typeof a.token_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(a.token_sha256) || !Array.isArray(a.tasks))
        throw new Error("нет token_sha256 или tasks");
      const prio = PRIORITIES.includes(a.priority) ? a.priority : "night";
      const h = a.token_sha256.toLowerCase();
      // Один токен в двух файлах — непонятно, чьи права: не пускаем ни одного.
      if (owner.has(h)) { log("ОШИБКА: один токен в", owner.get(h), "и", n, "— оба отключены"); dups.add(h); continue; }
      owner.set(h, n);
      apps.set(h, { id, tasks: new Set(a.tasks.filter((t) => typeof t === "string")), priority: prio });
    } catch (e) {
      // Битый файл при перечитывании не отнимает у приложения доступ.
      const old = prevById.get(id);
      log("ОШИБКА в приложении", n, "—", e.message, old ? "(оставляю прежнее)" : "(пропускаю)");
      if (old) apps.set(old[0], old[1]);
    }
  }
  for (const h of dups) apps.delete(h);
  return apps;
}

let TASKS = loadTasks(null);
let APPS = loadApps(null);
process.on("SIGHUP", () => { TASKS = loadTasks(TASKS); APPS = loadApps(APPS); log("настройки перечитаны"); });

// --- очередь: по одной на каждый бэкенд, с ограничением одновременных вызовов
const queues = new Map(); // backend -> {running, waiting: []}
function queue(name) {
  let q = queues.get(name);
  if (!q) { q = { running: 0, waiting: [] }; queues.set(name, q); }
  return q;
}
function pump(name) {
  const q = queue(name);
  const be = TASKS.backends.get(name);
  const limit = be ? be.concurrency : 1;
  while (q.running < limit && q.waiting.length) { q.running++; const w = q.waiting.shift(); clearTimeout(w.timer); w.resolve(true); }
}
// Встать в очередь. null — очередь полна (ответить 429). w.ready даёт true —
// очередь дошла, false — ждали дольше max_wait_s (ответить 503, а не висеть:
// модель может быть занята одним длинным ответом сколько угодно).
function enqueue(name, prio) {
  const q = queue(name);
  const be = TASKS.backends.get(name);
  if (q.waiting.length >= be.maxQueue && q.running >= be.concurrency) return null;
  const w = { rank: PRIORITIES.indexOf(prio), seq: process.hrtime.bigint(), since: Date.now() };
  w.ready = new Promise((resolve) => { w.resolve = resolve; });
  w.timer = setTimeout(() => { cancel(name, w); w.resolve(false); }, be.maxWaitMs);
  q.waiting.push(w);
  q.waiting.sort((a, b) => a.rank - b.rank || (a.seq < b.seq ? -1 : 1));
  pump(name);
  return w;
}
function cancel(name, w) { clearTimeout(w.timer); const q = queue(name); const i = q.waiting.indexOf(w); if (i >= 0) q.waiting.splice(i, 1); }
function release(name) { const q = queue(name); if (q.running > 0) q.running--; pump(name); }

// --- ответы в формате OpenAI
function send(res, code, obj, extra) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), ...extra });
  res.end(body);
}
function fail(res, code, type, message, extra) { send(res, code, { error: { type, message, code: type } }, extra); }

function auth(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)$/.exec(h);
  if (!m) return null;
  return APPS.get(crypto.createHash("sha256").update(m[1]).digest("hex")) || null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0; let over = false;
    req.on("data", (c) => { if (over) return; size += c.length; if (size > limit) { over = true; reject(Object.assign(new Error("слишком большой запрос"), { tooLarge: true })); } else parts.push(c); });
    req.on("end", () => { if (!over) resolve(Buffer.concat(parts)); });
    req.on("error", reject);
  });
}

// --- учёт: файл на каждый день, каталог создан при старте
try { fs.mkdirSync(USAGE_DIR, { recursive: true }); } catch (e) { log("ОШИБКА каталог учёта:", e.message); }
function usage(rec) {
  const f = path.join(USAGE_DIR, `usage-${rec.ts.slice(0, 10)}.jsonl`);
  fs.appendFile(f, JSON.stringify(rec) + "\n", (e) => { if (e) log("ОШИБКА учёт:", e.message); });
}

// Токены из потока SSE: берём последний кусок с "usage" (его шлёт бэкенд при
// stream_options.include_usage), держим в памяти только хвост, не весь ответ.
function sseUsage() {
  let tail = ""; let u = null;
  return {
    feed(c) {
      tail += c.toString("utf8");
      const lines = tail.split("\n"); tail = lines.pop().slice(-65536);
      for (const l of lines) if (l.startsWith("data:") && l.includes('"usage"')) { try { u = JSON.parse(l.slice(5)).usage || u; } catch {} }
    },
    get() { return u || {}; },
  };
}

async function chat(req, res, app) {
  let raw;
  try { raw = await readBody(req, BODY_LIMIT); } catch (e) {
    if (e.tooLarge) { fail(res, 413, "invalid_request_error", `запрос больше ${BODY_LIMIT >> 20} МБ`, { connection: "close" }); req.resume(); return; }
    throw e;
  }
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch (e) { return fail(res, 400, "invalid_request_error", "тело запроса — не JSON: " + e.message); }
  raw = null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "invalid_request_error", "тело запроса — не объект JSON");
  const task = body.model;
  if (typeof task !== "string" || !TASKS.tasks.has(task)) {
    // Задача есть на других моделях коробки — сказать, где (магазин покажет).
    const where = typeof task === "string" && TASKS.unavailable.has(task) ? `: ${TASKS.unavailable.get(task)}` : "";
    return fail(res, 404, "not_found_error", `задачи «${String(task)}» на этой коробке нет${where}`);
  }
  if (!app.tasks.has(task)) return fail(res, 403, "permission_error", `приложению «${app.id}» задача «${task}» не разрешена`);
  const route = TASKS.tasks.get(task);
  const be = TASKS.backends.get(route.backend);
  const bname = route.backend;

  // Приоритет: не выше, чем у приложения.
  let prio = app.priority;
  const asked = String(req.headers["x-devuz-priority"] || "");
  if (PRIORITIES.includes(asked) && PRIORITIES.indexOf(asked) > PRIORITIES.indexOf(prio)) prio = asked;

  const t0 = Date.now();
  const w = enqueue(bname, prio);
  if (!w) {
    usage({ ts: new Date().toISOString(), app: app.id, task, model: route.model, prio, wait_ms: 0, ms: 0, status: 429 });
    return fail(res, 429, "rate_limit_error", "коробка занята, повторите позже", { "retry-after": "5" });
  }
  // Клиент ушёл, пока ждал в очереди, — убираем его, модель зря не гоняем.
  let gone = false;
  const onGone = () => { gone = true; cancel(bname, w); };
  res.on("close", onGone);
  const ok = await w.ready;
  res.off("close", onGone);
  if (!ok) {
    usage({ ts: new Date().toISOString(), app: app.id, task, model: route.model, prio, wait_ms: Date.now() - t0, ms: Date.now() - t0, status: 503 });
    if (!gone && !res.destroyed) fail(res, 503, "overloaded_error", `очередь не дошла за ${be.maxWaitMs / 1000} с, повторите позже`, { "retry-after": "10" });
    return;
  }
  if (gone || res.destroyed) { release(bname); return; }

  const waited = Date.now() - t0;
  let done = false;
  const finish = (rec) => { if (done) return; done = true; release(bname); usage({ ts: new Date().toISOString(), app: app.id, task, model: route.model, prio, wait_ms: waited, ms: Date.now() - t0, ...rec }); };

  try {
    const stream = body.stream === true;
    const fwd = { ...body, model: route.model };
    if (stream) fwd.stream_options = { ...(body.stream_options || {}), include_usage: true };
    const out = Buffer.from(JSON.stringify(fwd));
    body = null;
    const url = new URL(be.url + "/chat/completions");
    const mod = url.protocol === "https:" ? https : http;
    const up = mod.request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": out.length } }, (r) => {
      res.writeHead(r.statusCode || 502, { "content-type": r.headers["content-type"] || "application/json", "x-devuz-task": task, "x-devuz-priority": prio });
      const sse = stream ? sseUsage() : null;
      const chunks = []; let size = 0;
      r.on("data", (c) => {
        if (sse) sse.feed(c);
        else if ((size += c.length) <= USAGE_BUF_LIMIT) chunks.push(c);
        if (!res.write(c)) { r.pause(); res.once("drain", () => r.resume()); }
      });
      r.on("end", () => {
        if (!r.complete) return; // обрыв — разберётся "close"
        res.end();
        let u = {};
        if (sse) u = sse.get();
        else if (size <= USAGE_BUF_LIMIT) { try { u = JSON.parse(Buffer.concat(chunks).toString("utf8")).usage || {}; } catch {} }
        finish({ status: r.statusCode, prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null });
      });
      r.on("close", () => {
        if (r.complete) return;
        // Бэкенд оборвал ответ посреди — клиенту честный обрыв, а не вечное ожидание.
        finish({ status: 502 });
        res.destroy();
      });
    });
    // Бэкенд молчит дольше timeout_s (до первого байта или между кусками) — обрыв.
    up.setTimeout(be.timeoutMs, () => up.destroy(Object.assign(new Error(`модель молчит дольше ${be.timeoutMs / 1000} с`), { timeout: true })));
    up.on("error", (e) => {
      const code = e.timeout ? 504 : 503;
      finish({ status: code });
      if (!res.headersSent) fail(res, code, "unavailable", "модель недоступна: " + e.message);
      else res.destroy();
    });
    res.on("close", () => { if (!done) { up.destroy(); finish({ status: 499 }); } });
    up.end(out);
  } catch (e) {
    finish({ status: 500 });
    throw e;
  }
}

function health(res) {
  const q = {};
  const now = Date.now();
  for (const [name, x] of queues) q[name] = { running: x.running, waiting: x.waiting.length, oldest_wait_s: x.waiting.length ? Math.round((now - Math.min(...x.waiting.map((w) => w.since))) / 1000) : 0 };
  send(res, 200, { status: "ok", api: "v1", box_class: TASKS.boxClass, tasks: TASKS.tasks.size, queues: q });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://core");
  if (req.method === "GET" && url.pathname === "/v1/health") return health(res);
  const app = auth(req);
  if (!app) return fail(res, 401, "authentication_error", "нужен токен приложения (Authorization: Bearer …)", { "www-authenticate": "Bearer" });
  const mine = () => [...app.tasks].filter((t) => TASKS.tasks.has(t));
  const model = (t) => ({ id: t, object: "model", owned_by: "devuz" });
  if (req.method === "GET" && url.pathname === "/v1/models") return send(res, 200, { object: "list", data: mine().map(model) });
  if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
    let id;
    try { id = decodeURIComponent(url.pathname.slice("/v1/models/".length)); } catch { return fail(res, 400, "invalid_request_error", "кривое имя задачи в адресе"); }
    return mine().includes(id) ? send(res, 200, model(id)) : fail(res, 404, "not_found_error", `задачи «${id}» нет`);
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") return chat(req, res, app);
  return fail(res, 404, "not_found_error", "нет такого метода в API v1");
}

const onRequest = (req, res) => handle(req, res).catch((e) => { log("ошибка", e.stack); fail(res, 500, "api_error", "внутренняя ошибка"); });
const server = http.createServer(onRequest);
server.listen(8090, "127.0.0.1", () => log("слушаю 127.0.0.1:8090"));
try { fs.mkdirSync(path.dirname(SOCK), { recursive: true }); fs.rmSync(SOCK, { force: true }); } catch {}
const sockServer = http.createServer(onRequest);
sockServer.listen(SOCK, () => { fs.chmodSync(SOCK, 0o666); log("слушаю", SOCK); });

// Node в контейнере — PID 1: без своего обработчика SIGTERM игнорируется,
// и каждый stop ждал бы 10 с до SIGKILL.
process.on("SIGTERM", () => {
  log("останавливаюсь");
  server.close(); sockServer.close();
  setTimeout(() => process.exit(0), 5000).unref();
  server.closeIdleConnections?.(); sockServer.closeIdleConnections?.();
});
