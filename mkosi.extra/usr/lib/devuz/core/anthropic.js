// SPDX-License-Identifier: LGPL-2.1-or-later
// Вход «Ядра» в формате Anthropic (POST /v1/messages): код студии зовёт
// модель через SDK Anthropic (`anthropic(site)`, ИИ-сотрудник), и на коробке
// он работает без переделки. Здесь только перевод запроса Anthropic в
// /chat/completions и ответа обратно — по образцу lib/llm/openai-compat.ts
// студии; очередь, права и учёт — общие с /v1/chat/completions (server.js).
//
// Модель зовётся без потока; если клиент просил поток, готовый ответ
// отдаётся потоком событий Anthropic (текст приходит сразу целиком).
// Что Claude умеет, а здесь отбрасывается: кэш промпта, effort, бетты.
"use strict";

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n\n");
}

// Сообщения Anthropic → сообщения OpenAI. Системный промпт — первым.
function toOpenAiMessages(system, messages) {
  const out = [];
  const sys = textOf(system);
  if (sys) out.push({ role: "system", content: sys });
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content.filter((b) => b && typeof b === "object") : [];
    if (m.role === "assistant") {
      const calls = blocks.filter((b) => b.type === "tool_use")
        .map((b) => ({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      const text = textOf(blocks);
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Ответ инструмента у OpenAI — отдельное сообщение `tool`, раньше текста.
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: textOf(b.content) || (b.is_error ? "error" : "ok") });
    }
    const text = textOf(blocks);
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function toOpenAiTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.filter((t) => t && typeof t.input_schema === "object" && typeof t.name === "string")
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
  return out.length ? out : undefined;
}

function toolChoice(c) {
  if (!c || typeof c !== "object") return undefined;
  if (c.type === "auto") return "auto";
  if (c.type === "any") return "required";
  if (c.type === "none") return "none";
  if (c.type === "tool" && typeof c.name === "string") return { type: "function", function: { name: c.name } };
  return undefined;
}

// Тело запроса Anthropic → тело /chat/completions. model — задача «Ядра»
// (chat, code…), её подменит маршрут, как и у OpenAI-входа.
function toOpenAiRequest(body) {
  const tools = toOpenAiTools(body.tools);
  const choice = tools ? toolChoice(body.tool_choice) : undefined;
  return {
    model: body.model,
    messages: toOpenAiMessages(body.system, body.messages),
    max_tokens: Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : 1024,
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length ? { stop: body.stop_sequences } : {}),
    ...(tools ? { tools } : {}),
    ...(choice ? { tool_choice: choice } : {}),
    stream: false,
  };
}

// Рассуждение модели (Qwen3 и т. п.) — не для ответа.
function withoutThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
}

const STOP = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };

function parseArgs(raw) {
  if (typeof raw !== "string") return raw ?? {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// Ответ /chat/completions → сообщение Anthropic. model — задача, как её
// назвал клиент (какая модель за ней — дело коробки).
function fromOpenAiResponse(body, task) {
  const choice = ((body && body.choices) || [])[0] || {};
  const message = choice.message || {};
  const content = [];
  const text = withoutThinking(typeof message.content === "string" ? message.content : "");
  if (text) content.push({ type: "text", text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  calls.forEach((call, i) => {
    const fn = (call && call.function) || {};
    content.push({ type: "tool_use", id: String(call.id ?? `toolu_d${i}`), name: String(fn.name ?? ""), input: parseArgs(fn.arguments) });
  });
  const usage = (body && body.usage) || {};
  return {
    id: "msg_" + String(body && body.id ? body.id : Date.now()).replace(/[^A-Za-z0-9_-]/g, ""),
    type: "message",
    role: "assistant",
    model: task,
    content,
    stop_reason: calls.length ? "tool_use" : (STOP[String(choice.finish_reason ?? "stop")] ?? "end_turn"),
    stop_sequence: null,
    usage: { input_tokens: Number(usage.prompt_tokens) || 0, output_tokens: Number(usage.completion_tokens) || 0 },
  };
}

// Готовое сообщение — потоком событий Anthropic (как ждёт messages.stream).
function sseFromMessage(message) {
  const ev = [];
  ev.push({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  ev.push({ type: "message_stop" });
  return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

// Ошибка — в виде ошибки Anthropic (SDK покажет её как обычно).
const ERR_TYPE = { authentication_error: "authentication_error", permission_error: "permission_error", not_found_error: "not_found_error",
  rate_limit_error: "rate_limit_error", overloaded_error: "overloaded_error", invalid_request_error: "invalid_request_error" };
function errorBody(code, type, message) {
  const t = ERR_TYPE[type] || (code === 429 ? "rate_limit_error" : code === 529 || code === 503 ? "overloaded_error" : code >= 500 ? "api_error" : "invalid_request_error");
  return { type: "error", error: { type: t, message } };
}

module.exports = { toOpenAiRequest, fromOpenAiResponse, sseFromMessage, errorBody };
