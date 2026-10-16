// PF2e Claude Bridge — клиентская часть.
// Работает только у ГМа: подключается к локальному MCP-серверу по WebSocket
// и выполняет его команды через API Foundry / pf2e.

const MODULE_ID = "pf2e-claude-bridge";
const RECONNECT_MS = 5000;

let socket = null;
let reconnectTimer = null;
let status = "off"; // off | connecting | connected | error

// ---------- Настройки ----------

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "port", {
    name: "Порт моста",
    hint: "Должен совпадать с PF2E_BRIDGE_PORT в конфиге Claude Desktop (по умолчанию 47811).",
    scope: "client", config: true, type: Number, default: 47811,
    onChange: () => reconnect(),
  });
  game.settings.register(MODULE_ID, "secret", {
    name: "Секрет",
    hint: "Должен совпадать с PF2E_BRIDGE_SECRET в конфиге Claude Desktop.",
    scope: "client", config: true, type: String, default: "",
    onChange: () => reconnect(),
  });
  game.settings.register(MODULE_ID, "enabled", {
    name: "Подключаться к Claude",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => reconnect(),
  });
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  if (game.system.id !== "pf2e") {
    ui.notifications.warn("PF2e Claude Bridge рассчитан на систему pf2e — часть инструментов не будет работать.");
  }
  connect();
});

// ---------- Соединение ----------

function setStatus(s, note) {
  if (s === status) return;
  status = s;
  if (s === "connected") ui.notifications.info("Claude Bridge: подключено");
  if (s === "error" && note) console.warn(`[${MODULE_ID}]`, note);
}

function connect() {
  clearTimeout(reconnectTimer);
  if (!game.settings.get(MODULE_ID, "enabled")) return setStatus("off");

  const secret = game.settings.get(MODULE_ID, "secret");
  if (!secret) {
    ui.notifications.warn("Claude Bridge: задайте секрет в настройках модуля.");
    return setStatus("off");
  }

  const port = game.settings.get(MODULE_ID, "port");
  setStatus("connecting");
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    setStatus("error", e.message);
    return scheduleReconnect();
  }

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "hello",
      secret,
      info: { world: game.world.title, user: game.user.name, system: game.system.id },
    }));
  });

  socket.addEventListener("message", async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "welcome") return setStatus("connected");
    if (msg.type === "request") return handleRequest(msg);
  });

  socket.addEventListener("close", (ev) => {
    socket = null;
    if (ev.code === 4003) {
      ui.notifications.error("Claude Bridge: неверный секрет — проверьте настройки модуля.");
      return setStatus("error", "bad secret");
    }
    setStatus("connecting");
    scheduleReconnect();
  });

  // Ошибку подробно не логируем: пока Claude Desktop закрыт, это нормальное состояние.
  socket.addEventListener("error", () => {});
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, RECONNECT_MS);
}

function reconnect() {
  if (socket) { try { socket.close(); } catch {} }
  socket = null;
  status = "off";
  connect();
}

async function handleRequest({ id, method, params }) {
  const reply = (payload) => socket?.readyState === 1 && socket.send(JSON.stringify({ type: "response", id, ...payload }));
  const handler = HANDLERS[method];
  if (!handler) return reply({ ok: false, error: `Неизвестная команда: ${method}` });
  try {
    reply({ ok: true, result: await handler(params ?? {}) });
  } catch (e) {
    console.error(`[${MODULE_ID}] ${method}`, e);
    reply({ ok: false, error: e?.message ?? String(e) });
  }
}

// ---------- Утилиты ----------

function findScene(ref) {
  if (!ref) return game.scenes.active ?? canvas.scene;
  return game.scenes.get(ref) ?? game.scenes.getName(ref)
    ?? game.scenes.find((s) => s.name.toLowerCase().includes(ref.toLowerCase()));
}

const DISPOSITION = { [-2]: "секрет", [-1]: "враг", 0: "нейтрал", 1: "союзник" };

// Состояния pf2e с уровнем: «Испуган 2», «Ранен 1».
function conditionsOf(actor) {
  try {
    const list = actor?.conditions?.active ?? [];
    return list.map((c) => (c.value ? `${c.name} ${c.value}` : c.name));
  } catch {
    return [];
  }
}

function summarizeToken(t, grid, origin) {
  const a = t.actor;
  const hp = a?.system?.attributes?.hp;
  const out = {
    id: t.id,
    name: t.name,
    col: Math.round((t.x - origin.x) / grid),
    row: Math.round((t.y - origin.y) / grid),
    size: t.width > 1 || t.height > 1 ? `${t.width}x${t.height}` : undefined,
    side: DISPOSITION[t.disposition] ?? t.disposition,
    hidden: t.hidden || undefined,
    actorId: a?.id,
    type: a?.type,
    level: a?.level,
    hp: hp ? `${hp.value}/${hp.max}${hp.temp ? ` (+${hp.temp} врем.)` : ""}` : undefined,
    ac: a?.system?.attributes?.ac?.value,
  };
  const conds = conditionsOf(a);
  if (conds.length) out.conditions = conds;
  if (t.actorLink === false && a?.type === "npc" && a?.name !== t.name) out.actorName = a.name;
  return out;
}

// ---------- Команды ----------

const HANDLERS = {
  "world-info": async () => {
    const combat = game.combat;
    return {
      world: game.world.title,
      system: `${game.system.id} ${game.system.version}`,
      foundry: game.version,
      activeScene: game.scenes.active ? { id: game.scenes.active.id, name: game.scenes.active.name } : null,
      usersOnline: game.users.filter((u) => u.active).map((u) => `${u.name}${u.isGM ? " (ГМ)" : ""}`),
      combat: combat ? { round: combat.round, started: combat.started, turn: combat.combatant?.name ?? null } : null,
    };
  },

  "get-scene": async ({ scene }) => {
    const s = findScene(scene);
    if (!s) throw new Error(`Сцена не найдена: ${scene ?? "(активной нет)"}`);
    const grid = s.grid.size;
    const dims = s.dimensions;
    const origin = { x: dims.sceneX, y: dims.sceneY };
    return {
      id: s.id,
      name: s.name,
      active: s.active,
      sizeInCells: { cols: Math.round(dims.sceneWidth / grid), rows: Math.round(dims.sceneHeight / grid) },
      feetPerCell: s.grid.distance,
      darkness: s.environment?.darknessLevel ?? s.darkness ?? 0,
      tokens: s.tokens.map((t) => summarizeToken(t, grid, origin)),
    };
  },
};

// Для отладки из консоли браузера: game.modules.get("pf2e-claude-bridge").api
Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { status: () => status, reconnect, handlers: HANDLERS };
});
