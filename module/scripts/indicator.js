// Плашка состояния связи с Claude (только у ГМа).
//   ● зелёная — мост подключён к серверу Claude Desktop
//   ● жёлтая  — подключаемся (Claude Desktop закрыт или перезапускается)
//   ● красная — неверный секрет
//   ● серая   — отключено в настройках
// Справа — сколько событий ждёт в очереди для Claude. Клик — переподключиться.
import { MODULE_ID } from "./util.js";

const STATES = {
  connected: { color: "#3fb950", text: "на связи" },
  connecting: { color: "#d29922", text: "нет связи — откройте Claude Desktop" },
  error: { color: "#f85149", text: "неверный секрет — проверьте настройки модуля" },
  off: { color: "#6e7681", text: "отключён в настройках" },
};

let el = null;
let state = "off";
let queued = 0;

const STYLE = `
#pf2e-claude-indicator {
  position: fixed; top: 6px; left: 50%; transform: translateX(-50%); z-index: 100;
  display: flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 12px;
  background: rgba(20, 20, 24, 0.85); border: 1px solid rgba(255,255,255,0.15);
  color: #e6edf3; font-size: 12px; line-height: 16px; cursor: pointer; user-select: none;
  box-shadow: 0 1px 4px rgba(0,0,0,0.5);
}
#pf2e-claude-indicator:hover { border-color: rgba(255,255,255,0.4); }
#pf2e-claude-indicator .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
#pf2e-claude-indicator .dot.pulse { animation: pf2e-claude-pulse 1.4s ease-in-out infinite; }
#pf2e-claude-indicator .queue {
  min-width: 16px; padding: 0 5px; border-radius: 8px; text-align: center;
  background: #8957e5; color: #fff; font-weight: 600;
}
#pf2e-claude-indicator .queue.empty { display: none; }
@keyframes pf2e-claude-pulse { 50% { opacity: 0.35; } }
`;

function name() {
  try { return game.settings.get(MODULE_ID, "assistantName") || "Гриша"; } catch { return "Гриша"; }
}

function render() {
  if (!el) return;
  const s = STATES[state] ?? STATES.off;
  el.innerHTML = `<span class="dot${state === "connecting" ? " pulse" : ""}" style="background:${s.color}"></span>`
    + `<span>${name()}</span>`
    + `<span class="queue${queued ? "" : " empty"}">${queued}</span>`;
  el.title = `${name()}: ${s.text}`
    + (queued ? `\nВ очереди: ${queued} — напишите Claude «очередь»` : "")
    + `\nКлик — переподключиться`;
}

export function createIndicator(onClick) {
  if (!game.user.isGM || el) return;
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  el = document.createElement("div");
  el.id = "pf2e-claude-indicator";
  el.addEventListener("click", () => onClick?.());
  document.body.append(el);
  render();

  Hooks.on(`${MODULE_ID}.status`, (s) => { state = s; render(); });
  Hooks.on(`${MODULE_ID}.queue`, (n) => { queued = n; render(); });
}

export function setIndicatorState(s) {
  state = s;
  render();
}
