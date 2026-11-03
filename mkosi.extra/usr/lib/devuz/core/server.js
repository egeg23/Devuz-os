// SPDX-License-Identifier: LGPL-2.1-or-later
// «Ядро» DevUz — шлюз моделей и первый кусок API платформы (v1).
// Node без пакетов. Слушает 127.0.0.1:8090 и сокет /run/devuz/core/core.sock
// (сокет — для приложений в песочнице без сети, недели 6–7).
//
// API v1 (совместим с OpenAI):
//   GET  /v1/health            — живо ли «Ядро» (без токена);
//   GET  /v1/models            — задачи, доступные этому токену;
//   POST /v1/chat/completions  — model = задача («chat», «chat-uz», «code»…),
//                                 «Ядро» само выбирает модель по таблице коробки.
// Токен приложения — Authorization: Bearer <токен>. На коробке хранится
// только sha256 токена: /etc/devuz/core/apps.d/<приложение>.json
//   {"token_sha256": "...", "tasks": ["chat"], "priority": "staff"}
// Приоритеты очереди: live > chat > staff > night. Приложение может только
// понизить свой приоритет (заголовок X-DevUz-Priority), но не повысить.
// Учёт: /var/lib/devuz/core/usage.jsonl — кто, задача, токены, время.
// Облако выключено: задачи ведут только на адреса из таблицы коробки.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TASKS_FILES = ["/etc/devuz/core/tasks.json", "/usr/share/devuz/core/tasks.json"];
const APPS_DIR = "/etc/devuz/core/apps.d";
const USAGE = "/var/lib/devuz/core/usage.jsonl";
const SOCK = "/run/devuz/core/core.sock";
const PRIORITIES = ["live", "chat", "staff", "night"];

function log(...a) { console.log("DEVUZ-CORE", ...a); }

function loadTasks() {
  for (const f of TASKS_FILES) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code !== "ENOENT") log("ошибка в", f, e.message); }
  }
  return { backends: {}, tasks: {} };
}

function loadApps() {
  const apps = new Map();
  let names = [];
  try { names = fs.readdirSync(APPS_DIR).filter((n) => n.endsWith(".json")); } catch { return apps; }
  for (const n of names) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(APPS_DIR, n), "utf8"));
      if (typeof a.token_sha256 !== "string" || !Array.isArray(a.tasks)) throw new Error("нет token_sha256 или tasks");
      const prio = PRIORITIES.includes(a.priority) ? a.priority : "night";
      apps.set(a.token_sha256.toLowerCase(), { id: n.slice(0, -5), tasks: new Set(a.tasks), priority: prio });
    } catch (e) { log("пропускаю", n, e.message); }
  }
  return apps;
}

let TASKS = loadTasks();
let APPS = loadApps();
process.on("SIGHUP", () => { TASKS = loadTasks(); APPS = loadApps(); log("настройки перечитаны"); });

// --- очередь: по одной на каждый бэкенд, с ограничением одновременных вызовов
const queues = new Map(); // backend -> {running, limit, waiting: []}
function acquire(backend, limit, prio) {
  let q = queues.get(backend);
  if (!q) { q = { running: 0, limit, waiting: [] }; queues.set(backend, q); }
  q.limit = limit;
  if (q.running < q.limit && q.waiting.length === 0) { q.running++; return Promise.resolve(); }
  return new Promise((resolve) => {
    q.waiting.push({ rank: PRIORITIES.indexOf(prio), seq: process.hrtime.bigint(), resolve });
    q.waiting.sort((a, b) => a.rank - b.rank || (a.seq < b.seq ? -1 : 1));
  });
}
function release(backend) {
  const q = queues.get(backend);
  if (!q) return;
  const next = q.waiting.shift();
  if (next) next.resolve(); else q.running--;
}

// --- ответы в формате OpenAI
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function fail(res, code, type, message) { send(res, code, { error: { type, message, code } }); }

function auth(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(\S+)$/.exec(h);
  if (!m) return null;
  return APPS.get(crypto.createHash("sha256").update(m[1]).digest("hex")) || null;
}

function readBody(req, limit = 8 << 20) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("слишком большой запрос")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

function usage(rec) {
  fs.mkdir(path.dirname(USAGE), { recursive: true }, () => {
    fs.appendFile(USAGE, JSON.stringify(rec) + "\n", () => {});
  });
}

async function chat(req, res, app) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString("utf8")); } catch (e) { return fail(res, 400, "invalid_request_error", "тело запроса — не JSON: " + e.message); }
  const task = body.model;
  const route = TASKS.tasks[task];
  if (!route) return fail(res, 404, "not_found_error", `задачи «${task}» на этой коробке нет`);
  if (!app.tasks.has(task)) return fail(res, 403, "permission_error", `приложению «${app.id}» задача «${task}» не разрешена`);
  const be = TASKS.backends[route.backend];
  if (!be) return fail(res, 503, "unavailable", `нет бэкенда «${route.backend}»`);

  // Приоритет: не выше, чем у приложения.
  let prio = app.priority;
  const asked = String(req.headers["x-devuz-priority"] || "");
  if (PRIORITIES.includes(asked) && PRIORITIES.indexOf(asked) > PRIORITIES.indexOf(prio)) prio = asked;

  const t0 = Date.now();
  await acquire(route.backend, be.concurrency || 1, prio);
  const waited = Date.now() - t0;
  const out = Buffer.from(JSON.stringify({ ...body, model: route.model }));
  const url = new URL(be.url.replace(/\/+$/, "") + "/chat/completions");
  let done = false;
  const finish = (rec) => { if (done) return; done = true; release(route.backend); usage({ ts: new Date().toISOString(), app: app.id, task, model: route.model, prio, wait_ms: waited, ms: Date.now() - t0, ...rec }); };

  const up = http.request(url, { method: "POST", headers: { "content-type": "application/json", "content-length": out.length } }, (r) => {
    const chunks = [];
    res.writeHead(r.statusCode || 502, { "content-type": r.headers["content-type"] || "application/json", "x-devuz-task": task, "x-devuz-priority": prio });
    r.on("data", (c) => { chunks.push(c); res.write(c); });
    r.on("end", () => {
      res.end();
      let u = {};
      try { u = JSON.parse(Buffer.concat(chunks).toString("utf8")).usage || {}; } catch { /* поток SSE — токены не считаем */ }
      finish({ status: r.statusCode, prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null });
    });
    r.on("error", () => finish({ status: 502 }));
  });
  up.on("error", (e) => { finish({ status: 503 }); if (!res.headersSent) fail(res, 503, "unavailable", "модель недоступна: " + e.message); else res.end(); });
  res.on("close", () => { if (!done) up.destroy(); });
  up.end(out);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://core");
  if (req.method === "GET" && url.pathname === "/v1/health") return send(res, 200, { status: "ok", api: "v1" });
  const app = auth(req);
  if (!app) return fail(res, 401, "authentication_error", "нужен токен приложения (Authorization: Bearer …)");
  if (req.method === "GET" && url.pathname === "/v1/models")
    return send(res, 200, { object: "list", data: [...app.tasks].filter((t) => TASKS.tasks[t]).map((t) => ({ id: t, object: "model", owned_by: "devuz" })) });
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") return chat(req, res, app);
  return fail(res, 404, "not_found_error", "нет такого метода в API v1");
}

const server = http.createServer((req, res) => handle(req, res).catch((e) => { log("ошибка", e.stack); if (!res.headersSent) fail(res, 500, "api_error", "внутренняя ошибка"); }));
server.listen(8090, "127.0.0.1", () => log("слушаю 127.0.0.1:8090"));
try { fs.mkdirSync(path.dirname(SOCK), { recursive: true }); fs.rmSync(SOCK, { force: true }); } catch {}
const sockServer = http.createServer((req, res) => handle(req, res).catch(() => fail(res, 500, "api_error", "внутренняя ошибка")));
sockServer.listen(SOCK, () => { fs.chmodSync(SOCK, 0o666); log("слушаю", SOCK); });
