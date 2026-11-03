// Только тестовый образ: поддельная модель на 127.0.0.1:8091.
// Отвечает «эхом»; «sleep:N» в тексте — думает N секунд; в ответе — номер
// по порядку, в котором запросы начали обрабатываться (для теста очереди).
"use strict";
const http = require("node:http");
let n = 0;
http.createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const b = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    const text = String((b.messages || []).map((m) => m.content).join(" "));
    const order = ++n;
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
