#!/usr/bin/env node
// pf2e-claude-bridge — MCP-сервер.
// Claude Desktop запускает его по stdio. Сервер поднимает WebSocket на 127.0.0.1,
// к которому подключается модуль Foundry из вкладки ГМа. Команды Claude
// пересылаются в модуль, ответы возвращаются обратно.
//
// ВАЖНО: stdout занят протоколом MCP — все логи только в stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PF2E_BRIDGE_PORT || 47811);
const SECRET = process.env.PF2E_BRIDGE_SECRET || "";
const ALLOWED_ORIGINS = (process.env.PF2E_BRIDGE_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const REQUEST_TIMEOUT_MS = 30_000;

const log = (...a) => console.error("[pf2e-bridge]", ...a);

if (!SECRET) {
  log("PF2E_BRIDGE_SECRET не задан — задайте его в конфиге Claude Desktop.");
  process.exit(1);
}

// ---------- WebSocket-мост к Foundry ----------

let foundry = null;            // активное аутентифицированное соединение
let foundryInfo = null;        // что модуль сообщил о себе при подключении
const pending = new Map();     // id запроса -> {resolve, reject, timer}

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: ({ origin }, cb) => {
    if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
      log("Отклонено подключение с origin", origin);
      return cb(false, 403, "Origin not allowed");
    }
    cb(true);
  },
});

wss.on("listening", () => log(`WebSocket слушает ws://127.0.0.1:${PORT}`));
wss.on("error", (e) => {
  if (e.code === "EADDRINUSE") log(`Порт ${PORT} занят — уже запущен другой экземпляр моста?`);
  else log("Ошибка WebSocket:", e.message);
});

wss.on("connection", (ws) => {
  let authed = false;
  const authTimer = setTimeout(() => !authed && ws.close(4001, "auth timeout"), 5000);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (!authed) {
      if (msg.type === "hello" && msg.secret === SECRET) {
        authed = true;
        clearTimeout(authTimer);
        if (foundry && foundry !== ws) foundry.close(4002, "replaced by new connection");
        foundry = ws;
        foundryInfo = msg.info || null;
        ws.send(JSON.stringify({ type: "welcome" }));
        log("Foundry подключён:", foundryInfo?.world ?? "?", "/", foundryInfo?.user ?? "?");
      } else {
        ws.close(4003, "bad secret");
      }
      return;
    }

    if (msg.type === "response" && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "Ошибка в Foundry"));
    }
  });

  ws.on("close", () => {
    if (foundry === ws) {
      foundry = null;
      foundryInfo = null;
      log("Foundry отключился");
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Foundry отключился во время запроса"));
        pending.delete(id);
      }
    }
  });
});

function callFoundry(method, params = {}) {
  if (!foundry || foundry.readyState !== 1) {
    return Promise.reject(new Error(
      "Foundry не подключён. Откройте мир в Chrome под ГМом с включённым модулем «PF2e Claude Bridge» " +
      "и проверьте, что секрет в настройках модуля совпадает с конфигом Claude Desktop."
    ));
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Foundry не ответил за ${REQUEST_TIMEOUT_MS / 1000} с (${method})`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    foundry.send(JSON.stringify({ type: "request", id, method, params }));
  });
}

// ---------- MCP ----------

const mcp = new McpServer({ name: "pf2e-claude-bridge", version: "0.1.0" });

const asText = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
});

// Обёртка: любая ошибка превращается в понятный ответ инструмента, а не в падение сервера.
function tool(name, description, inputSchema, method = name) {
  mcp.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return asText(await callFoundry(method, args ?? {}));
    } catch (e) {
      return { ...asText(`Ошибка: ${e.message}`), isError: true };
    }
  });
}

tool(
  "world-info",
  "Информация о подключённом мире Foundry: название, система и её версия, версия Foundry, " +
  "активная сцена, кто из пользователей онлайн, идёт ли бой. Начинайте с этого инструмента.",
  {}
);

tool(
  "get-scene",
  "Компактное описание сцены (по умолчанию активной): размер в клетках, футы на клетку, " +
  "список токенов с позицией в клетках (col,row от левого верхнего угла сцены), " +
  "отношением (враг/союзник/нейтрал), видимостью, уровнем, HP, КБ и состояниями pf2e.",
  {
    scene: z.string().optional().describe("ID или название сцены. Пусто — активная сцена."),
  }
);

await mcp.connect(new StdioServerTransport());
log("MCP-сервер запущен");
