// Разбор сообщений чата pf2e в компактный вид.
import { MODULE_ID, stripHtml } from "./util.js";

export const OUTCOME_RU = {
  criticalSuccess: "крит. успех",
  success: "успех",
  failure: "провал",
  criticalFailure: "крит. провал",
};

const KIND_RU = {
  "attack-roll": "атака",
  "spell-attack-roll": "атака заклинанием",
  "saving-throw": "спасбросок",
  "skill-check": "проверка навыка",
  "perception-check": "проверка Восприятия",
  "damage-roll": "урон",
  "damage-taken": "получен урон",
  "initiative": "инициатива",
  "flat-check": "чистая проверка",
  "check": "проверка",
  "spell-cast": "заклинание",
  "self-effect": "действие",
};

export function ctxOf(msg) {
  return msg.flags?.pf2e?.context ?? null;
}

/** Цели сообщения: из контекста pf2e, иначе — сохранённые модулем при создании. */
export function targetsOf(msg) {
  const ctx = ctxOf(msg);
  const uuids = [];
  if (ctx?.target?.token) uuids.push(ctx.target.token);
  for (const u of msg.flags?.[MODULE_ID]?.targets ?? []) if (!uuids.includes(u)) uuids.push(u);
  return uuids.map((u) => fromUuidSync(u)).filter(Boolean);
}

export function originItem(msg) {
  try {
    if (msg.item) return msg.item;
  } catch { /* у некоторых карточек getter бросает */ }
  const uuid = msg.flags?.pf2e?.origin?.uuid;
  return uuid ? fromUuidSync(uuid) : null;
}

/**
 * Карточка без броска: заклинание, умение, действие. У заклинаний со спасброском pf2e кладёт
 * context.type = "spell-cast", у действий с эффектом на себя — "self-effect"; у остальных контекста нет.
 */
export function isCardMessage(msg) {
  if (msg.rolls?.length) return false;
  const type = ctxOf(msg)?.type;
  return !type || type === "spell-cast" || type === "self-effect";
}

/** Настоящий бросок урона pf2e (а не любой бросок без d20 вроде «/r 1d4»). */
export function isDamageMessage(msg) {
  if (!msg.isDamageRoll || !msg.rolls?.[0]) return false;
  if (ctxOf(msg)?.type === "damage-roll") return true;
  const roll = msg.rolls[0];
  return roll.constructor?.name === "DamageRoll" || roll instanceof (CONFIG.Dice.rolls.find((r) => r.name === "DamageRoll") ?? class {});
}

/**
 * Ключи, по которым спасбросок цели связывается с уроном того же заклинания.
 * Берём сырые данные flags.pf2e.origin (одинаковые в карточке, спасброске и уроне),
 * а не найденный предмет: для свитков, жезлов и повышенных рангов он у каждой карточки свой.
 */
export function spellKeys(msg, item) {
  const o = msg.flags?.pf2e?.origin ?? {};
  const keys = [];
  if (o.uuid) keys.push(`u:${o.uuid}`);
  const slug = (o.rollOptions ?? []).find((r) => typeof r === "string" && r.startsWith("origin:item:slug:"))?.slice(17)
    ?? item?.slug ?? null;
  const caster = o.actor ?? item?.actor?.uuid ?? null;
  if (slug && caster) keys.push(`s:${caster}:${slug}`);
  else if (item?.name && caster) keys.push(`n:${caster}:${item.name.toLowerCase()}`);
  if (!keys.length && item?.uuid) keys.push(`u:${item.uuid}`);
  return keys;
}

/** Название действия из roll options: «action:demoralize» → demoralize. */
export function actionSlug(msg) {
  const opts = ctxOf(msg)?.options ?? [];
  const a = opts.find((o) => typeof o === "string" && o.startsWith("action:") && o.split(":").length === 2);
  return a ? a.split(":")[1] : null;
}

export function summarizeMessage(msg, { raw = false } = {}) {
  const ctx = ctxOf(msg);
  const roll = msg.rolls?.[0];
  const item = originItem(msg);
  const flavor = (msg.flavor ?? "").replace(/<span class="action-glyph">.*?<\/span>/g, "");
  const title = stripHtml(flavor, 120).split(/ (Цель|Target|Результат|Result):/)[0] || undefined;
  const out = {
    id: msg.id,
    at: new Date(msg.timestamp).toLocaleTimeString("ru-RU"),
    who: msg.speaker?.alias ?? msg.author?.name,
    kind: ctx?.type ? KIND_RU[ctx.type] ?? ctx.type : (msg.isDamageRoll ? "урон" : roll ? "бросок" : "сообщение"),
    title,
    item: item?.name,
    action: actionSlug(msg) ?? undefined,
    total: roll?.total,
    formula: roll && !ctx ? roll.formula : undefined,
    dc: ctx?.dc?.value,
    outcome: ctx?.outcome ? OUTCOME_RU[ctx.outcome] ?? ctx.outcome : undefined,
    targets: targetsOf(msg).map((t) => t.name),
    targetIds: targetsOf(msg).map((t) => t.id),
    whisper: msg.whisper?.length ? true : undefined,
  };
  if (!out.targets.length) { delete out.targets; delete out.targetIds; }
  if (!roll && !ctx) out.text = stripHtml(msg.content, 300) || undefined;
  if (raw) out.raw = { context: ctx, origin: msg.flags?.pf2e?.origin, rolls: msg.rolls?.map((r) => r.formula) };
  return out;
}
