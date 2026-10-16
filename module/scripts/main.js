// PF2e Claude Bridge — клиентская часть.
// Работает только у ГМа: подключается к локальному MCP-серверу по WebSocket
// и выполняет его команды через API Foundry / pf2e.
import { MODULE_ID } from "./util.js";
import { sceneHandlers } from "./handlers/scene.js";
import { encounterHandlers } from "./handlers/encounter.js";
import { statusHandlers } from "./handlers/status.js";
import { registerAutomationSettings, registerAutomationHooks } from "./automation.js";

const HANDLERS = { ...sceneHandlers, ...encounterHandlers, ...statusHandlers };
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

  // Автоматика работает и без подключения к Claude — регистрируем у всех клиентов,
  // но применяет эффекты только активный ГМ.
  registerAutomationSettings();
  registerAutomationHooks();
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { status: () => status, reconnect, handlers: HANDLERS };

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
      info: {
        world: game.world.title,
        user: game.user.name,
        system: game.system.id,
        moduleVersion: game.modules.get(MODULE_ID)?.version,
      },
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

  // Пока Claude Desktop закрыт, ошибки подключения — нормальное состояние.
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
  if (!handler) {
    return reply({ ok: false, error: `Модуль не знает команду «${method}» — обновите модуль в Foundry до версии сервера.` });
  }
  try {
    reply({ ok: true, result: await handler(params ?? {}) });
  } catch (e) {
    console.error(`[${MODULE_ID}] ${method}`, e);
    reply({ ok: false, error: e?.message ?? String(e) });
  }
}
