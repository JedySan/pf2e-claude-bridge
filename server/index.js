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

const mcp = new McpServer({ name: "pf2e-claude-bridge", version: "0.6.3" });

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
  "Импортировать монстра из компендиума в мир (папка «Созданные враги»), при желании " +
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
  "Список актёров мира с фильтрами. folder='encounter' — только из папки «Созданные враги».",
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

// ---------- Чат, очередь, статусы ----------

const tokensArg = z.array(z.string()).min(1)
  .describe("ID токенов (из get-scene) или их имена на сцене; имя должно быть однозначным");

tool(
  "get-chat",
  "Новые сообщения чата Foundry с прошлой проверки в сжатом виде: кто, что (атака, спасбросок, " +
  "действие, урон), итог броска, КС, степень успеха, цели. all=true — последние limit сообщений.",
  {
    limit: z.number().int().min(1).max(100).optional().describe("По умолчанию 20"),
    all: z.boolean().optional(),
    raw: z.boolean().optional().describe("Добавить сырой контекст pf2e (для отладки)"),
  }
);

tool(
  "get-queue",
  "Очередь событий, которые автоматика модуля оставила для Claude: исходы спасбросков против " +
  "заклинаний, урон, который нельзя применить автоматически, действия без правила, обращения к ассистенту («@Гриша …», с messageId для ответа через send-chat-message) " +
  "из чата. По умолчанию очередь очищается после чтения.",
  { peek: z.boolean().optional().describe("Только посмотреть, не очищая") }
);

tool(
  "undo-history",
  "История последних изменений автоматики и Claude (урон, лечение, состояния, эффекты), которые можно отменить. " +
  "Хранится во вкладке ГМа до перезагрузки страницы.",
  { limit: z.number().int().min(1).max(30).optional() }
);

tool(
  "undo",
  "Отменить последние изменения (или одно по id из undo-history): вернуть HP, убрать наложенные состояния и эффекты, " +
  "вернуть снятые. Более поздние изменения тех же существ не затираются.",
  {
    id: z.string().optional().describe("id из undo-history; пусто — последнее изменение"),
    steps: z.number().int().min(1).max(10).optional().describe("Сколько последних изменений отменить (по умолчанию 1)"),
  }
);

tool(
  "list-conditions",
  "Список состояний pf2e: slug и название на языке мира.",
  {}
);

tool(
  "set-condition",
  "Наложить, изменить или снять состояние pf2e на токенах. value: число — точное значение " +
  "(Испуган 2), не указано — просто наложить, 0 — снять.",
  {
    scene: sceneArg,
    tokens: tokensArg,
    condition: z.string().describe("slug (frightened, prone, off-guard…) или русское название"),
    value: z.number().int().min(0).optional(),
  }
);

tool(
  "search-effects",
  "Поиск эффектов pf2e (эффекты заклинаний, эликсиров, способностей, аур) по названию " +
  "в мире и компендиумах. Возвращает uuid для apply-effect.",
  {
    query: z.string(),
    limit: z.number().int().min(1).max(100).optional(),
  }
);

tool(
  "apply-effect",
  "Наложить эффект pf2e на токены. Можно задать свою длительность.",
  {
    scene: sceneArg,
    tokens: tokensArg,
    uuid: z.string().describe("uuid из search-effects"),
    duration: z.object({
      value: z.number().int(),
      unit: z.enum(["rounds", "minutes", "hours", "days", "unlimited", "encounter"]),
    }).optional(),
  }
);

tool(
  "remove-effect",
  "Снять эффекты с токенов по части названия или ID эффекта.",
  { scene: sceneArg, tokens: tokensArg, name: z.string() }
);

tool(
  "apply-damage",
  "Нанести урон токенам. С типом урона (fire, slashing, mental…) pf2e учтёт сопротивления, " +
  "слабости и иммунитеты; без типа — урон как есть.",
  {
    scene: sceneArg,
    tokens: tokensArg,
    amount: z.number().int().min(1),
    type: z.string().optional(),
  }
);

tool(
  "heal",
  "Восстановить HP токенам (не выше максимума).",
  { scene: sceneArg, tokens: tokensArg, amount: z.number().int().min(1) }
);

tool(
  "send-chat-message",
  "Написать в чат Foundry. По умолчанию — от имени ассистента (Гриша) шёпотом ГМу. " +
  "Так отвечают на обращения «@Гриша …» из очереди — в to передавайте поле reply из элемента очереди. to: 'gm' — шёпотом ГМу, 'all' — всем, " +
  "или имя игрока/его персонажа — шёпотом ему (и ГМу). as — токен на сцене, от имени которого говорить (реплика NPC).",
  {
    text: z.string().describe("Текст; пустая строка между абзацами"),
    to: z.string().optional().describe("gm | all | имя игрока или персонажа; по умолчанию gm"),
    as: z.string().optional().describe("ID или имя токена — говорить от его лица"),
    scene: sceneArg,
    replyTo: z.string().optional().describe("ID сообщения, на которое отвечаем (из очереди)"),
  }
);

tool(
  "get-token-state",
  "Текущее состояние токенов: HP, состояния, эффекты.",
  { scene: sceneArg, tokens: tokensArg }
);

// ---------- Заклинания за персонажей и добыча ----------

tool(
  "cast-spell",
  "Сотворить заклинание за персонажа или NPC по целям: находит заклинание в его листе, выделяет цели " +
  "у ГМа и отправляет карточку в чат (с расходом ячейки/использования, если есть). Спасброски NPC-целей " +
  "бросит автоматика модуля, исходы придут в очередь. Атаку/урон из карточки бросает ГМ.",
  {
    scene: sceneArg,
    caster: z.string().describe("Токен заклинателя: ID или имя на сцене"),
    spell: z.string().describe("Название заклинания (рус. или англ., можно часть)"),
    rank: z.number().int().min(0).max(10).optional().describe("Ранг; по умолчанию — как подготовлено"),
    targets: z.array(z.string()).optional().describe("Токены-цели: ID или имена"),
  }
);

tool(
  "search-items",
  "Поиск предметов для добычи во всех компендиумах: оружие, доспехи, снаряжение, расходники, ценности. " +
  "Фильтры по названию, уровню, типу и редкости. Возвращает uuid для add-loot.",
  {
    query: z.string().optional(),
    minLevel: z.number().int().optional(),
    maxLevel: z.number().int().optional(),
    types: z.array(z.enum(["weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack"])).optional(),
    rarity: z.enum(["common", "uncommon", "rare", "unique"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }
);

tool(
  "create-chest",
  "Создать на сцене сундук (актёр pf2e типа loot, папка «Созданные враги») в клетке col,row. " +
  "Содержимое кладётся через add-loot или collect-loot.",
  {
    scene: sceneArg,
    name: z.string().optional().describe("По умолчанию «Сундук»"),
    col: z.number().int(),
    row: z.number().int(),
    hidden: z.boolean().optional().describe("Скрыть от игроков, пока не найдут"),
    img: z.string().optional(),
  }
);

tool(
  "collect-loot",
  "Собрать добычу с мобов в сундук: оружие, доспехи, снаряжение, расходники, ценности и монеты " +
  "(природные удары не трогаются). Без from — со всех поверженных врагов на сцене.",
  {
    scene: sceneArg,
    chest: z.string().describe("Токен сундука: ID или имя"),
    from: z.array(z.string()).optional().describe("Токены мобов; пусто — все поверженные враги"),
  }
);

tool(
  "add-loot",
  "Положить добычу в инвентарь моба или сундука на сцене: предметы из компендиума (с переводом) и монеты. " +
  "Ориентир по ценности — таблица сокровищ GM Core для уровня партии; не больше доли от бюджета уровня на энкаунтер.",
  {
    scene: sceneArg,
    token: z.string().describe("Токен моба: ID или имя"),
    items: z.array(z.object({ uuid: z.string(), quantity: z.number().int().min(1).optional() })).optional(),
    coins: z.object({ pp: z.number().int(), gp: z.number().int(), sp: z.number().int(), cp: z.number().int() }).partial().optional(),
  }
);

// ---------- Кузня существ (модуль jedysan-kuznya) ----------

const tier = z.union([z.enum(["extreme", "high", "moderate", "low", "terrible"]), z.number()])
  .describe("Ступень GM Core или своё число");
const creatureSpec = z.object({
  name: z.string(),
  level: z.number().int().min(-1).max(24),
  role: z.enum(["balanced", "brute", "soldier", "skirmisher", "sniper", "magicalStriker", "spellcaster", "skillParagon"])
    .optional().describe("Шаблон по дорожным картам GM Core; явные поля ниже его перекрывают"),
  size: z.enum(["tiny", "sm", "med", "lg", "huge", "grg"]).optional(),
  rarity: z.enum(["common", "uncommon", "rare", "unique"]).optional(),
  traits: z.array(z.string()).optional().describe("Трейты pf2e на английском: humanoid, undead, aquatic…"),
  languages: z.array(z.string()).optional(),
  senses: z.array(z.string()).optional().describe("darkvision, low-light-vision, scent 30, tremorsense 60…"),
  description: z.string().optional(),
  attributes: z.object({ str: tier, dex: tier, con: tier, int: tier, wis: tier, cha: tier }).partial().optional(),
  perception: tier.optional(),
  ac: tier.optional(),
  hp: z.union([z.enum(["high", "moderate", "low"]), z.number()]).optional(),
  saves: z.object({ fortitude: tier, reflex: tier, will: tier }).partial().optional(),
  skills: z.array(z.object({ slug: z.string().describe("athletics, stealth, arcana…"), tier })).optional(),
  speed: z.object({ land: z.number(), fly: z.number(), swim: z.number(), climb: z.number(), burrow: z.number() }).partial().optional(),
  strikes: z.array(z.object({
    name: z.string(),
    ranged: z.boolean().optional(),
    range: z.number().optional().describe("Шаг дистанции, фт"),
    damageType: z.string().describe("slashing, piercing, bludgeoning, fire, cold, acid, poison, mental…"),
    attack: tier,
    damage: z.string().describe("Ступень (extreme|high|moderate|low) или формула «2d8+6»"),
    traits: z.array(z.string()).optional().describe("agile, reach-10, finesse, deadly-d10, magical…"),
    extra: z.string().optional().describe("Доп. урон: «1d6 fire», «1d4 persistent bleed»"),
  })).optional(),
  spellcasting: z.object({
    tradition: z.enum(["arcane", "divine", "occult", "primal"]),
    type: z.enum(["innate", "prepared", "spontaneous"]),
    tier: z.enum(["extreme", "high", "moderate"]),
    attribute: z.enum(["int", "wis", "cha"]).optional(),
    spells: z.array(z.object({ name: z.string().describe("Название (англ. или рус.)"), rank: z.number().int().min(0).max(10).optional() })),
  }).nullable().optional(),
  iwr: z.array(z.object({
    kind: z.enum(["immunity", "weakness", "resistance"]),
    type: z.string(),
    value: z.union([z.enum(["max", "min"]), z.number()]).optional().describe("max — узкое, min — широкое; для иммунитета не нужно"),
  })).optional(),
  abilities: z.array(z.object({ name: z.string() })).optional()
    .describe("Способности из компендиумов pf2e по названию: Grab, Reactive Strike, Knockdown, Regeneration, Ferocity…"),
});

tool(
  "forge-roles",
  "Роли-шаблоны Кузни существ (дорожные карты GM Core) с кратким описанием.",
  {}
);

tool(
  "forge-preview",
  "Посчитать числа существа по таблицам GM Core без создания: характеристики, КБ, HP, спасброски, " +
  "удары, КС заклинаний, сопротивления и предупреждения о балансе. Используйте, чтобы проверить задумку.",
  { spec: creatureSpec }
);

tool(
  "forge-open",
  "Открыть у ГМа мастер Кузни существ с готовой заготовкой. ГМ проверит, поправит и создаст сам. " +
  "Предпочтительный способ: ГМ сохраняет контроль.",
  { spec: creatureSpec }
);

tool(
  "forge-rescale",
  "Перевести готового NPC (любого, не только из Кузни) на другой уровень по таблицам GM Core: " +
  "каждая характеристика сохраняет ступень и ручные поправки; атаки, урон, КС заклинаний, " +
  "сопротивления пересчитываются. copy=true — создать копию, оригинал не трогать. " +
  "Все токены этого актёра на сценах тоже получат новые числа.",
  {
    actorId: z.string().describe("ID или точное имя актёра мира"),
    level: z.number().int().min(-1).max(24),
    copy: z.boolean().optional(),
  }
);

tool(
  "forge-create",
  "Сразу создать существо в мире (папка «Кузня существ») и открыть его лист. Используйте, когда ГМ " +
  "явно попросил создать без проверки. Возвращает actorId для place-tokens.",
  { spec: creatureSpec }
);

await mcp.connect(new StdioServerTransport());
log("MCP-сервер запущен");

// Клиент (Claude Desktop) закрыл stdio — завершаемся, чтобы не держать порт «зомби»-процессом.
const shutdown = () => { log("Клиент отключился — завершаю работу"); process.exit(0); };
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
mcp.server.onclose = shutdown;
