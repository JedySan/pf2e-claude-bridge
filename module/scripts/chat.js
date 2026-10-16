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
  const title = stripHtml(msg.flavor, 120).split(/ (Цель|Target|Результат|Result):/)[0] || undefined;
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
    whisper: msg.whisper?.length ? true : undefined,
  };
  if (!out.targets.length) delete out.targets;
  if (!roll && !ctx) out.text = stripHtml(msg.content, 300) || undefined;
  if (raw) out.raw = { context: ctx, origin: msg.flags?.pf2e?.origin, rolls: msg.rolls?.map((r) => r.formula) };
  return out;
}
