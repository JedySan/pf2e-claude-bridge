// Кнопки ГМа в карточках чата (в духе PF2e Toolbelt):
//   урон      — применить по целям ×½ / ×1 / ×2, отменить;
//   лечение   — лечить цели, отменить;
//   заклинание со спасброском — бросить спасброски NPC-целей;
//   действие навыка — отменить то, что повесила автоматика.
// Цели — выделенные автором в момент броска; если их нет — токены, выбранные сейчас у ГМа.
import { MODULE_ID } from "./util.js";
import { targetsOf, originItem, ctxOf } from "./chat.js";
import { applyRollDamage, healActor } from "./pf2e-ops.js";
import { undoGroup, undo, hasUndoFor } from "./undo.js";
import { healsTarget, rollTargetSaves } from "./automation.js";

const STYLE = `
.pcb-buttons { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; margin-top: 4px;
  padding-top: 4px; border-top: 1px dashed rgba(127,127,127,.5); font-size: 11px; }
.pcb-buttons .pcb-label { opacity: .7; margin-right: 2px; }
.pcb-buttons button { flex: 0 0 auto; width: auto; min-width: 30px; height: 20px; line-height: 18px;
  padding: 0 6px; font-size: 11px; margin: 0; }
.pcb-buttons button.pcb-undo.empty { opacity: .45; }
`;

function addStyle() {
  if (document.getElementById("pcb-chat-style")) return;
  const el = document.createElement("style");
  el.id = "pcb-chat-style";
  el.textContent = STYLE;
  document.head.append(el);
}

function kindsOf(roll) {
  return roll?.kinds instanceof Set ? roll.kinds : new Set(roll?.options?.kinds ?? ["damage"]);
}

function targetsFor(msg) {
  const t = targetsOf(msg).filter((x) => x.actor);
  if (t.length) return t;
  return (canvas.tokens?.controlled ?? []).map((x) => x.document).filter((x) => x.actor);
}

function button(text, title, onClick, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  if (cls) b.className = cls;
  b.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    b.disabled = true;
    try { await onClick(); } catch (e) {
      console.error(`[${MODULE_ID}] кнопка чата`, e);
      ui.notifications.error(`Умный помощник: ${e.message}`);
    } finally { b.disabled = false; }
  });
  return b;
}

function undoButton(msg) {
  return button("↶", "Отменить то, что применено по этой карточке", async () => {
    const r = await undo({ messageId: msg.id });
    if (!r) return ui.notifications.warn("Нечего отменять по этой карточке (история живёт до перезагрузки страницы).");
    ui.notifications.info(`Отменено: ${r.targets.join("; ")}`);
  }, `pcb-undo${hasUndoFor(msg.id) ? "" : " empty"}`);
}

async function applyDamage(msg, multiplier) {
  const roll = msg.rolls[0];
  const item = originItem(msg);
  const targets = targetsFor(msg);
  if (!targets.length) return ui.notifications.warn("Нет целей: выделите цели (T) или выберите токены.");
  const rollOptions = new Set(ctxOf(msg)?.options ?? []);
  const label = `${msg.speaker?.alias ?? "?"}: ${item?.name ?? "урон"} ×${multiplier}`;
  await undoGroup(label, async () => {
    for (const t of targets) {
      if (healsTarget(roll, t.actor)) await healActor(t.actor, roll.total);
      else await applyRollDamage(t.actor, t, roll, multiplier, { item, rollOptions });
    }
  }, { messageId: msg.id });
}

async function healTargets(msg) {
  const roll = msg.rolls[0];
  const targets = targetsFor(msg);
  if (!targets.length) return ui.notifications.warn("Нет целей: выделите цели (T) или выберите токены.");
  await undoGroup(`${msg.speaker?.alias ?? "?"}: лечение ${roll.total}`, async () => {
    for (const t of targets) await healActor(t.actor, roll.total);
  }, { messageId: msg.id });
}

function decorate(msg, html) {
  if (!game.user.isGM || msg.flags?.[MODULE_ID]?.assistant) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".pcb-buttons")) return;
  const ctx = ctxOf(msg);
  const bar = document.createElement("div");
  bar.className = "pcb-buttons";
  const label = (t) => { const s = document.createElement("span"); s.className = "pcb-label"; s.textContent = t; bar.append(s); };

  if (msg.isDamageRoll && msg.rolls?.[0]) {
    const kinds = kindsOf(msg.rolls[0]);
    if (kinds.has("healing") && !kinds.has("damage")) {
      label("Гриша:");
      bar.append(button("✚ Лечить цели", "Восстановить HP целям (или выбранным токенам)", () => healTargets(msg)));
    } else {
      label("По целям:");
      bar.append(
        button("×½", "Половина урона", () => applyDamage(msg, 0.5)),
        button("×1", "Полный урон", () => applyDamage(msg, 1)),
        button("×2", "Двойной урон", () => applyDamage(msg, 2)),
      );
    }
    bar.append(undoButton(msg));
  } else if (!msg.rolls?.length && !ctx) {
    const item = originItem(msg);
    if (item?.type !== "spell" || !item.system?.defense?.save?.statistic) return;
    label("Гриша:");
    bar.append(button("🎲 Спасброски NPC", "Бросить спасброски NPC-целей против этого заклинания", async () => {
      const n = await rollTargetSaves(msg, item);
      if (!n) ui.notifications.warn("Нет NPC-целей в этой карточке (выделите цели перед сотворением).");
    }));
  } else if (ctx?.type === "skill-check" && ctx.outcome && hasUndoFor(msg.id)) {
    label("Автоматика:");
    bar.append(undoButton(msg));
  } else {
    return;
  }

  const content = root.querySelector(".message-content") ?? root;
  content.append(bar);
}

export function registerChatButtons() {
  addStyle();
  Hooks.on("renderChatMessageHTML", (msg, html) => {
    try { decorate(msg, html); } catch (e) { console.error(`[${MODULE_ID}] кнопки чата`, e); }
  });
  // После применения/отмены — перерисовать кнопку ↶ в последних сообщениях.
  Hooks.on(`${MODULE_ID}.undo`, () => {
    for (const el of document.querySelectorAll(".chat-message[data-message-id] .pcb-undo")) {
      const id = el.closest("[data-message-id]")?.dataset.messageId;
      el.classList.toggle("empty", !hasUndoFor(id));
    }
    // Карточки действий без кнопок, по которым автоматика что-то повесила, — перерисовать.
    for (const el of document.querySelectorAll(".chat-message[data-message-id]")) {
      if (el.querySelector(".pcb-buttons")) continue;
      const msg = game.messages.get(el.dataset.messageId);
      if (msg && ctxOf(msg)?.type === "skill-check" && hasUndoFor(msg.id)) ui.chat?.updateMessage?.(msg);
    }
  });
}
