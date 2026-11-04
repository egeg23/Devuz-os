// SPDX-License-Identifier: LGPL-2.1-or-later
// Только тест: заглушка «Офиса» — проверяет договор ОС ↔ «Офис» (порт 8100,
// токен «Ядра», сокет, вход Anthropic). Настоящий «Офис» — в закрытом репозитории.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.env.OFFICE_PORT || 8100);
function core(text) {
  return new Promise((resolve) => {
    const token = fs.readFileSync(process.env.CORE_TOKEN_FILE, "utf8").trim();
    const body = JSON.stringify({ model: "chat", max_tokens: 32, messages: [{ role: "user", content: text }] });
    const req = http.request({ socketPath: process.env.CORE_SOCKET, path: "/v1/messages", method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (r) => {
      const parts = []; r.on("data", (c) => parts.push(c)); r.on("end", () => resolve({ status: r.statusCode, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.end(body);
  });
}
http.createServer(async (req, res) => {
  if (req.url === "/api/health") { res.writeHead(200); return res.end("ok"); }
  // Что пришло от Caddy: пометка «снаружи» и адрес посетителя (тест выхода наружу).
  if (req.url === "/api/via") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ via: req.headers["x-devuz-via"] || "", ip: req.headers["x-forwarded-for"] || "" }));
  }
  if (req.url.startsWith("/api/ai")) {
    const r = await core("привет из Офиса");
    res.writeHead(r.status === 200 ? 200 : 502, { "content-type": "application/json" });
    return res.end(r.body);
  }
  let data = "нет";
  try { fs.writeFileSync(process.env.OFFICE_DATA + "/probe", "ok"); data = "да"; } catch {}
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(`DevUz Офис (заглушка), данные пишутся: ${data}\n`);
}).listen(port, "127.0.0.1");
// Node в контейнере — PID 1: без своего обработчика SIGTERM игнорируется,
// podman через 10 с убивает (код 137) и служба считается упавшей. Договор:
// «Офис» сам завершается по SIGTERM.
process.on("SIGTERM", () => process.exit(0));
