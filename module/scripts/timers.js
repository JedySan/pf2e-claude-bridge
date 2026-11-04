// Таймеры состояний и начало хода.
// У состояний pf2e нет длительности, поэтому срок хранится во флаге самого состояния.
// Срок отсчитывается от участника боя, чей ход шёл при наложении: «1 раунд» кончается в начале
// его следующего хода. Всё выполняет только активный ГМ.
import { MODULE_ID } from "./util.js";
import { getCondition, setCondition } from "./pf2e-ops.js";
import { undoGroup } from "./undo.js";

const FLAG = "timer";
const ROUNDS_IN = { rounds: 1, minutes: 10, hours: 600 };
const isActiveGM = () => game.users.activeGM?.isSelf ?? game.user.isGM;

/** Длительность { value, unit } → раунды. */
export function toRounds({ value, unit }) {
  const k = ROUNDS_IN[unit];
  if (!k) throw new Error(`Неизвестная единица длительности: ${unit}`);
  return value * k;
}

/**
 * Поставить срок состоянию. rounds — сколько раундов, whileCondition — пока на актёре есть другое состояние.
 * Возвращает { warning }, если срок поставить нельзя: состояние остаётся без таймера.
 */
export async function setConditionTimer(actor, slug, { rounds, whileCondition } = {}) {
  const cond = getCondition(actor, slug);
  if (!cond) return { warning: `${actor.name}: нет состояния ${slug}` };
  const timer = {};
  if (whileCondition) timer.whileCondition = whileCondition;
  if (rounds) {
    const combat = game.combat;
    if (!combat?.started) return { warning: `${actor.name}: ${cond.name} без таймера — бой не идёт` };
    timer.combatId = combat.id;
    timer.combatantId = combat.combatant?.id ?? null;
    timer.expireRound = combat.round + rounds;
  }
  await cond.setFlag(MODULE_ID, FLAG, timer);
  return { timer };
}

/** Истёк ли срок. state: { combatId, round, combatantId, known(id), hasCondition(slug), ended }. */
export function isDue(timer, state) {
  if (timer.whileCondition && !state.hasCondition(timer.whileCondition)) return true;
  if (timer.expireRound === undefined) return false;
  if (state.ended || timer.combatId !== state.combatId) return true;
  if (state.round > timer.expireRound) return true;
  if (state.round < timer.expireRound) return false;
  return state.combatantId === timer.combatantId || !state.known(timer.combatantId);
}

/** Актёры боя и его сцены: состояние могли повесить и тому, кто не в трекере. */
function actorsOf(combat) {
  const actors = new Map();
  for (const c of combat.combatants) if (c.actor) actors.set(c.actor.uuid, c.actor);
  for (const t of combat.scene?.tokens ?? []) if (t.actor) actors.set(t.actor.uuid, t.actor);
  return [...actors.values()];
}

/** Снять истёкшие состояния. Возвращает строки для отчёта ГМу. */
async function expire(combat, { ended = false } = {}) {
  const removed = [];
  for (const actor of actorsOf(combat)) {
    for (const cond of [...(actor.itemTypes?.condition ?? [])]) {
      const timer = cond.flags?.[MODULE_ID]?.[FLAG];
      if (!timer) continue;
      const due = isDue(timer, {
        ended,
        combatId: combat.id,
        round: combat.round,
        combatantId: combat.combatant?.id ?? null,
        known: (id) => combat.combatants.has(id),
        hasCondition: (slug) => !!getCondition(actor, slug),
      });
      if (!due) continue;
      const name = cond.name;
      // Флаг снимаем до снимка отмены: иначе отмена вернёт состояние, а следующий ход снимет его снова.
      await cond.unsetFlag(MODULE_ID, FLAG);
      await setCondition(actor, cond.slug, 0);
      removed.push(`${actor.name}: ${name}`);
    }
  }
  return removed;
}

/** Сколько действий теряет ошеломлённый в начале хода. */
export function stunLoss(value, maxActions) {
  const lost = Math.min(value, maxActions);
  return { lost, left: maxActions - lost, next: value - lost };
}

const stunSeen = new Map();

/** Начало хода: напомнить про «Ошеломлён» и, если так настроено, снизить его. */
async function stunAtTurnStart(combat) {
  const mode = game.settings.get(MODULE_ID, "autoStunned");
  const c = combat.combatant;
  if (mode === "off" || !c?.actor) return null;
  // Возврат хода назад и повторный вход не должны снимать действия второй раз.
  const key = `${combat.id}.${c.id}`;
  if ((stunSeen.get(key) ?? 0) >= combat.round) return null;
  stunSeen.set(key, combat.round);

  const stunned = getCondition(c.actor, "stunned");
  const value = stunned?.value;
  if (!value) return null;
  const max = getCondition(c.actor, "quickened") ? 4 : 3;
  const { lost, left, next } = stunLoss(value, max);
  if (mode === "apply") await setCondition(c.actor, "stunned", next);
  const tail = mode === "apply" ? (next ? `теперь ${next}` : "снято") : `снизить до ${next} вручную`;
  return `${c.actor.name}: ${stunned.name} — теряет ${lost} из ${max} действий, остаётся ${left}; ${tail}`;
}

function report(lines) {
  if (!lines.length) return;
  const name = game.settings.get(MODULE_ID, "assistantName");
  return ChatMessage.create({
    content: lines.map((l) => `<p>${foundry.utils.escapeHTML?.(l) ?? l}</p>`).join(""),
    whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
    speaker: { alias: name },
    flags: { [MODULE_ID]: { assistant: true } },
  });
}

async function onTurn(combat) {
  const lines = [];
  await undoGroup("Начало хода: таймеры", async () => {
    // Сначала «Ошеломлён»: от него зависит эффект, который держится, пока существо ошеломлено.
    const stun = await stunAtTurnStart(combat);
    if (stun) lines.push(stun);
    const removed = await expire(combat);
    if (removed.length) lines.push(`Истёк срок: ${removed.join("; ")}`);
  });
  await report(lines);
}

async function onCombatEnd(combat) {
  let removed = [];
  await undoGroup("Конец боя: таймеры", async () => { removed = await expire(combat, { ended: true }); });
  if (removed.length) await report([`Бой окончен, сняты: ${removed.join("; ")}`]);
}

// Смены хода обрабатываем строго по очереди.
let chain = Promise.resolve();
const enqueueTick = (fn) => {
  chain = chain.then(fn).catch((e) => console.error(`[${MODULE_ID}] таймеры`, e));
};

export function registerTimerHooks() {
  Hooks.on("updateCombat", (combat, changes) => {
    if (!isActiveGM() || !combat.started) return;
    if (!("round" in changes) && !("turn" in changes)) return;
    enqueueTick(() => onTurn(combat));
  });
  Hooks.on("deleteCombat", (combat) => {
    if (!isActiveGM()) return;
    enqueueTick(() => onCombatEnd(combat));
  });
}
