// Только тестовый образ: поддельная модель на 127.0.0.1:8091.
// Отвечает «эхом»; в тексте: «sleep:N» — думает N секунд; «silent» — молчит
// (проверка таймаута «Ядра»); «abort» — рвёт ответ посередине. В ответе —
// номер по порядку, в котором запросы начали обрабатываться (тест очереди).
// GET /seen — какие тексты дошли до модели (тест брошенного запроса).
"use strict";
const http = require("node:http");
let n = 0;
const seen = [];
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/seen") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(seen)); }
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    let b = {};
    try { b = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); } catch { res.writeHead(400); return res.end(); }
    const text = String((b.messages || []).map((m) => m.content).join(" "));
    const order = ++n;
    seen.push(text);
    if (text.includes("silent")) return;
    if (text.includes("abort")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"id":"mock-' + order + '","choices":[');
      return setTimeout(() => req.socket.destroy(), 300);
    }
    const m = /sleep:(\d+)/.exec(text);
    setTimeout(() => {
      const body = JSON.stringify({ id: "mock-" + order, object: "chat.completion", model: b.model,
        choices: [{ index: 0, message: { role: "assistant", content: `order=${order} model=${b.model} echo=${text}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: text.length, completion_tokens: 5, total_tokens: text.length + 5 } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    }, m ? Number(m[1]) * 1000 : 0);
  });
}).listen(8091, "127.0.0.1");
