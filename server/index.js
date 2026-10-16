#!/usr/bin/env node
// pf2e-claude-bridge — MCP-сервер.
// Claude Desktop запускает его по stdio. Сервер поднимает WebSocket на 127.0.0.1,
// к которому подключается модуль Foundry из вкладки ГМа. Команды Claude
// пересылаются в модуль, ответы возвращаются обратно.
//
// ВАЖНО: stdout занят протоколом MCP — все логи только в stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket, { WebSocketServer } from "ws";
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
//
// Экземпляров сервера может быть несколько (Claude Desktop + удалённая сессия, Claude Code…),
// а порт один. Первый становится «основным»: держит порт, к нему подключается модуль Foundry.
// Остальные — «пиры»: подключаются к основному и шлют команды через него.
// Если основной завершился, пир сам занимает порт, и модуль переподключается к нему за ~5 с.

const NOT_CONNECTED =
  "Foundry не подключён. Откройте мир в Chrome под ГМом с включённым модулем «PF2e Claude Bridge» " +
  "и проверьте, что секрет в настройках модуля совпадает с конфигом Claude Desktop.";

let mode = "starting";         // starting | primary | peer
let foundry = null;            // (основной) соединение с модулем Foundry
let foundryInfo = null;
let peerSocket = null;         // (пир) соединение с основным экземпляром
const pending = new Map();     // id запроса -> {resolve, reject, timer}

function settle(id, ok, result, error) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  ok ? p.resolve(result) : p.reject(new Error(error || "Ошибка в Foundry"));
}

function rejectAll(reason) {
  for (const id of [...pending.keys()]) settle(id, false, null, reason);
}

function sendRequest(sock, method, params, timeoutMs) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Foundry не ответил за ${timeoutMs / 1000} с (${method})`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sock.send(JSON.stringify({ type: "request", id, method, params }));
  });
}

function callFoundry(method, params = {}) {
  if (mode === "primary") {
    if (!foundry || foundry.readyState !== 1) return Promise.reject(new Error(NOT_CONNECTED));
    return sendRequest(foundry, method, params, REQUEST_TIMEOUT_MS);
  }
  if (mode === "peer" && peerSocket?.readyState === 1) {
    return sendRequest(peerSocket, method, params, REQUEST_TIMEOUT_MS + 5000);
  }
  return Promise.reject(new Error("Мост переподключается, повторите через пару секунд. " + NOT_CONNECTED));
}

// --- Основной экземпляр ---

function startPrimary() {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: PORT,
    verifyClient: ({ origin }, cb) => {
      // Пиры (Node) приходят без Origin; браузер — с адресом Foundry.
      if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
        log("Отклонено подключение с origin", origin);
        return cb(false, 403, "Origin not allowed");
      }
      cb(true);
    },
  });

  wss.on("listening", () => {
    mode = "primary";
    log(`Основной экземпляр: WebSocket слушает ws://127.0.0.1:${PORT}`);
  });

  wss.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      log(`Порт ${PORT} занят другим экземпляром — подключаюсь к нему как пир`);
      wss.close();
      startPeer();
    } else {
      log("Ошибка WebSocket:", e.message);
    }
  });

  wss.on("connection", (ws) => {
    let role = null; // foundry | peer
    const authTimer = setTimeout(() => !role && ws.close(4001, "auth timeout"), 5000);

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!role) {
        if (msg.secret !== SECRET || (msg.type !== "hello" && msg.type !== "peer-hello")) {
          return ws.close(4003, "bad secret");
        }
        clearTimeout(authTimer);
        if (msg.type === "hello") {
          role = "foundry";
          if (foundry && foundry !== ws) foundry.close(4002, "replaced by new connection");
          foundry = ws;
          foundryInfo = msg.info || null;
          log("Foundry подключён:", foundryInfo?.world ?? "?", "/", foundryInfo?.user ?? "?",
            "/ модуль", foundryInfo?.moduleVersion ?? "?");
        } else {
          role = "peer";
          log("Подключился пир-экземпляр");
        }
        ws.send(JSON.stringify({ type: "welcome" }));
        return;
      }

      if (role === "foundry" && msg.type === "response") {
        return settle(msg.id, msg.ok, msg.result, msg.error);
      }

      // Пир просит выполнить команду — проксируем в Foundry и возвращаем ответ.
      if (role === "peer" && msg.type === "request") {
        let reply;
        try {
          reply = { ok: true, result: await callFoundry(msg.method, msg.params ?? {}) };
        } catch (e) {
          reply = { ok: false, error: e.message };
        }
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "response", id: msg.id, ...reply }));
      }
    });

    ws.on("close", () => {
      if (role === "foundry" && foundry === ws) {
        foundry = null;
        foundryInfo = null;
        log("Foundry отключился");
        rejectAll("Foundry отключился во время запроса");
      }
    });
  });
}

// --- Пир ---

function startPeer() {
  mode = "starting";
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  let welcomed = false;

  ws.on("open", () => ws.send(JSON.stringify({ type: "peer-hello", secret: SECRET })));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "welcome") {
      welcomed = true;
      peerSocket = ws;
      mode = "peer";
      log("Работаю через основной экземпляр");
    } else if (msg.type === "response") {
      settle(msg.id, msg.ok, msg.result, msg.error);
    }
  });

  ws.on("close", (code) => {
    if (peerSocket === ws) peerSocket = null;
    rejectAll("Связь с основным экземпляром моста прервалась");
    if (code === 4003) log("Основной экземпляр отклонил секрет — у экземпляров разные PF2E_BRIDGE_SECRET");
    else log(welcomed ? "Основной экземпляр отключился — пробую занять порт" : "Не удалось подключиться к основному экземпляру");
    mode = "starting";
    setTimeout(startPrimary, 1000 + Math.random() * 1000);
  });

  ws.on("error", () => {}); // обработка — в close
}

startPrimary();

// ---------- MCP ----------

const mcp = new McpServer({ name: "pf2e-claude-bridge", version: "0.2.1" });

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

// ---------- Мир и сцены ----------

const sceneArg = z.string().optional().describe("ID или название (можно часть) сцены. Пусто — активная сцена.");
const side = z.enum(["враг", "нейтрал", "союзник"]).optional();

tool(
  "list-scenes",
  "Список сцен мира: id, название, активна ли, сколько токенов.",
  { query: z.string().optional().describe("Фильтр по части названия") }
);

tool(
  "get-scene",
  "Компактное описание сцены (по умолчанию активной): размер в клетках, футы на клетку, " +
  "список токенов с позицией в клетках (col,row от левого верхнего угла игровой области), " +
  "стороной (враг/союзник/нейтрал), скрытостью, уровнем, HP, КБ и состояниями pf2e.",
  { scene: sceneArg }
);

tool(
  "place-tokens",
  "Поставить токены актёров мира на сцену по клеткам. Актёр должен уже быть в мире " +
  "(см. import-actor). Можно сразу сделать токен скрытым (подкрепление), задать имя и сторону.",
  {
    scene: sceneArg,
    tokens: z.array(z.object({
      actorId: z.string().describe("ID или точное имя актёра мира"),
      col: z.number().int().describe("Столбец клетки (0 — левый край игровой области)"),
      row: z.number().int().describe("Строка клетки (0 — верхний край)"),
      hidden: z.boolean().optional(),
      name: z.string().optional().describe("Имя токена, если отличается от актёра"),
      side: side.describe("Сторона; по умолчанию — из прототипа актёра"),
    })).min(1),
  }
);

tool(
  "update-tokens",
  "Изменить токены на сцене: переместить в клетку, скрыть/показать, переименовать, сменить сторону.",
  {
    scene: sceneArg,
    tokens: z.array(z.object({
      id: z.string().describe("ID токена (из get-scene)"),
      col: z.number().int().optional(),
      row: z.number().int().optional(),
      hidden: z.boolean().optional(),
      name: z.string().optional(),
      side,
    })).min(1),
  }
);

tool(
  "delete-tokens",
  "Удалить токены со сцены по их ID. Актёры в мире остаются (для них — delete-actors).",
  { scene: sceneArg, ids: z.array(z.string()).min(1) }
);

tool(
  "create-combat",
  "Создать бой на сцене и добавить в трекер токены. По умолчанию — все видимые токены с HP > 0; " +
  "скрытые (подкрепление) не добавляются, если не указано includeHidden. Инициативу бросает ГМ, " +
  "если не указано rollNpcInitiative.",
  {
    scene: sceneArg,
    tokenIds: z.array(z.string()).optional().describe("Конкретные токены; пусто — автоматически"),
    includeHidden: z.boolean().optional(),
    rollNpcInitiative: z.boolean().optional().describe("Сразу бросить инициативу всем NPC"),
  }
);

// ---------- Энкаунтеры ----------

tool(
  "search-compendium",
  "Поиск NPC/монстров во всех компендиумах актёров. Фильтры: часть названия (рус./англ.), " +
  "диапазон уровней, трейты (все должны совпасть, на английском: aquatic, undead, dragon…), редкость. " +
  "Возвращает uuid для import-actor и get-actor.",
  {
    query: z.string().optional(),
    minLevel: z.number().int().optional(),
    maxLevel: z.number().int().optional(),
    traits: z.array(z.string()).optional(),
    rarity: z.enum(["common", "uncommon", "rare", "unique"]).optional(),
    limit: z.number().int().min(1).max(100).optional().describe("По умолчанию 25"),
  }
);

tool(
  "get-actor",
  "Компактный стат-блок актёра: уровень, трейты, HP, КБ, спасброски, восприятие, скорости, " +
  "иммунитеты/слабости/сопротивления, навыки, удары (атака с MAP, урон, трейты), способности " +
  "(стоимость действий и краткий текст), заклинания. Работает и для актёров мира, и для uuid из компендиума.",
  {
    ref: z.string().describe("ID/точное имя актёра мира или uuid из search-compendium"),
    descMax: z.number().int().min(0).optional().describe("Длина текста способностей (0 — без текста, по умолчанию 200)"),
  }
);

tool(
  "import-actor",
  "Импортировать монстра из компендиума в мир (папка «Claude — энкаунтеры»), при желании " +
  "с шаблоном Elite (+1 уровень) или Weak (−1 уровень) и в нескольких копиях. Возвращает ID актёров для place-tokens.",
  {
    uuid: z.string().describe("uuid из search-compendium"),
    name: z.string().optional().describe("Своё имя; при count > 1 добавится номер"),
    adjustment: z.enum(["elite", "weak", "normal"]).optional(),
    count: z.number().int().min(1).max(10).optional().describe("Сколько отдельных актёров создать (по умолчанию 1)"),
  }
);

tool(
  "list-actors",
  "Список актёров мира с фильтрами. folder='encounter' — только созданные Claude для энкаунтеров.",
  {
    query: z.string().optional(),
    type: z.enum(["npc", "character", "hazard", "vehicle", "familiar", "party", "loot"]).optional(),
    folder: z.enum(["encounter"]).optional(),
  }
);

tool(
  "delete-actors",
  "Удалить актёров из мира по ID (уборка после энкаунтера). Персонажей игроков не удаляет никогда.",
  { ids: z.array(z.string()).min(1) }
);

tool(
  "encounter-budget",
  "Бюджет энкаунтера по правилам PF2e: XP каждого существа относительно уровня партии и итоговая угроза " +
  "(Тривиальная … Экстремальная) с поправкой на размер партии. Без creatures — считает врагов на сцене, " +
  "отдельно видимых и скрытых (подкрепление). Партия — герои на сцене, иначе партия мира, иначе явно.",
  {
    scene: sceneArg,
    partyLevel: z.number().int().optional(),
    partySize: z.number().int().min(1).optional(),
    creatures: z.array(z.object({
      name: z.string().optional(),
      level: z.number().int(),
      count: z.number().int().min(1).optional(),
    })).optional().describe("Гипотетический состав для расчёта до создания"),
  }
);

await mcp.connect(new StdioServerTransport());
log("MCP-сервер запущен");

// Клиент (Claude Desktop) закрыл stdio — завершаемся, чтобы не держать порт «зомби»-процессом.
const shutdown = () => { log("Клиент отключился — завершаю работу"); process.exit(0); };
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
mcp.server.onclose = shutdown;
