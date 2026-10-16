// Автоматика стола (в духе PF2e Toolbelt / Workbench).
// Выполняется ровно у одного клиента — активного ГМа, — чтобы ничего не применялось дважды.
// Каждая функция включается/выключается в настройках модуля.
import { MODULE_ID } from "./util.js";
import { ctxOf, targetsOf, originItem, actionSlug, OUTCOME_RU } from "./chat.js";
import { setCondition, applyRollDamage } from "./pf2e-ops.js";
import { enqueue } from "./queue.js";

const isActiveGM = () => game.users.activeGM?.isSelf ?? game.user.isGM;
const setting = (key) => game.settings.get(MODULE_ID, key);
const npcOnly = (actor) => !actor.hasPlayerOwner;

// Состояния по исходу действий навыков. [кому, slug, значение]; "-slug" — снять.
const ACTION_RULES = {
  demoralize: {
    criticalSuccess: [["target", "frightened", 2]],
    success: [["target", "frightened", 1]],
  },
  trip: {
    criticalSuccess: [["target", "prone"]],
    success: [["target", "prone"]],
    criticalFailure: [["self", "prone"]],
  },
  grapple: {
    criticalSuccess: [["target", "restrained"]],
    success: [["target", "grabbed"]],
  },
  escape: {
    criticalSuccess: [["self", "-grabbed"], ["self", "-restrained"], ["self", "-immobilized"]],
    success: [["self", "-grabbed"], ["self", "-restrained"], ["self", "-immobilized"]],
  },
};

// Действия, по которым Claude решать нечего (ремесло, знания, отдых, исследование…).
const NON_COMBAT_ACTIONS = new Set([
  "craft", "repair", "earn-income", "recall-knowledge", "identify-magic", "identify-alchemy", "learn-spell",
  "decipher-writing", "subsist", "treat-wounds", "treat-disease", "treat-poison", "administer-first-aid",
  "perform", "create-forgery", "gather-information", "make-an-impression", "coerce", "request", "sense-direction",
  "track", "cover-tracks", "borrow-arcane-spell", "climb", "swim", "balance", "squeeze", "high-jump", "long-jump",
  "force-open", "pick-a-lock", "disable-device", "palm-an-object", "steal", "conceal-an-object", "hide", "sneak",
  "avoid-notice", "seek", "sense-motive", "overdrive", "raise-a-shield", "take-cover",
]);

const BASIC_SAVE_MULTIPLIER ={ criticalSuccess: 0, success: 0.5, failure: 1, criticalFailure: 2 };

// Результаты спасбросков против заклинаний: «uuid заклинания|uuid токена» → исход.
// Нужны, чтобы урон базового спасброска применить с правильным множителем.
const saveOutcomes = new Map();
const SAVE_TTL_MS = 3 * 60 * 1000;

function rememberSave(itemUuid, tokenUuid, outcome) {
  saveOutcomes.set(`${itemUuid}|${tokenUuid}`, { outcome, at: Date.now() });
}

function recallSave(itemUuid, tokenUuid) {
  const r = saveOutcomes.get(`${itemUuid}|${tokenUuid}`);
  return r && Date.now() - r.at < SAVE_TTL_MS ? r.outcome : null;
}

export function registerAutomationSettings() {
  const reg = (key, name, hint, type, def, choices) =>
    game.settings.register(MODULE_ID, key, { name, hint, scope: "world", config: true, type, default: def, choices });

  reg("autoDamage", "Авто: урон по целям",
    "Применять урон из карточки урона к выбранным целям (с учётом сопротивлений/слабостей). " +
    "Для заклинаний с базовым спасброском — с множителем по результату спасброска цели.",
    String, "npc", { off: "Выключено", npc: "Только по NPC", all: "По всем целям" });
  reg("autoActionConditions", "Авто: состояния от действий",
    "Деморализовать → Испуган, Подсечка → Сбит с ног, Захват → Схвачен/Обездвижен, Вырваться → снять захват.",
    Boolean, true);
  reg("autoNpcSaves", "Авто: спасброски NPC",
    "Когда заклинание со спасброском применено к целям-NPC — бросить их спасброски автоматически.",
    Boolean, true);
  reg("autoDefeated", "Авто: поверженные",
    "NPC с 0 HP помечается мёртвым и поверженным в трекере боя.",
    Boolean, true);
  reg("claudeQueue", "Очередь для Claude",
    "Складывать в очередь исходы спасбросков, действия без автоматики и обращения к ассистенту — " +
    "Claude разберёт их по запросу.",
    Boolean, true);
  reg("assistantName", "Имя ассистента",
    "Под этим именем Claude отвечает в чате игры.",
    String, "Гриша");
  reg("assistantTriggers", "Обращения к ассистенту",
    "Через запятую. Сообщение в чате, начинающееся с одного из них, уходит Claude в очередь.",
    String, "@Гриша, @claude");
  reg("assistantAccess", "Кто может обращаться к ассистенту",
    "Только ГМ — ответы приходят ГМу шёпотом. Все — игроки тоже могут звать ассистента, " +
    "ответы на их вопросы видны всем; вопросы ГМа по-прежнему шёпотом.",
    String, "gm", { gm: "Только ГМ", all: "ГМ и игроки" });
}

/** Если сообщение — обращение к ассистенту, вернуть текст без обращения, иначе null. */
function assistantRequest(text) {
  const plain = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim();
  const triggers = setting("assistantTriggers").split(",").map((s) => s.trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const t of triggers) {
    if (plain.toLowerCase().startsWith(t.toLowerCase())) return plain.slice(t.length).replace(/^[\s,:—-]+/, "").trim();
  }
  return null;
}

export function registerAutomationHooks() {
  // Цели автора сохраняем в сообщении: pf2e кладёт цель не во все карточки (например, в карточку заклинания).
  Hooks.on("preCreateChatMessage", (msg) => {
    if (!game.user.targets.size) return;
    msg.updateSource({ [`flags.${MODULE_ID}.targets`]: [...game.user.targets].map((t) => t.document.uuid) });
  });

  Hooks.on("createChatMessage", (msg) => {
    if (!isActiveGM()) return;
    onChatMessage(msg).catch((e) => console.error(`[${MODULE_ID}] автоматика`, e));
  });

  Hooks.on("updateActor", (actor, changes) => {
    if (!isActiveGM() || !setting("autoDefeated")) return;
    const hp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
    if (hp === undefined || hp > 0 || actor.hasPlayerOwner || actor.type !== "npc") return;
    markDefeated(actor).catch((e) => console.error(`[${MODULE_ID}] поверженные`, e));
  });
}

async function markDefeated(actor) {
  await actor.toggleStatusEffect?.("dead", { active: true, overlay: true });
  const combatants = game.combat?.combatants.filter((c) => c.actor === actor || (!actor.isToken && c.actorId === actor.id)) ?? [];
  for (const c of combatants) if (!c.defeated) await c.update({ defeated: true });
}

async function onChatMessage(msg) {
  const ctx = ctxOf(msg);
  const item = originItem(msg);

  // 1. Обращение к ассистенту («@Гриша …»). Свои ответы ассистента не ловим.
  if (!ctx && !msg.rolls?.length && !msg.flags?.[MODULE_ID]?.assistant) {
    const question = assistantRequest(msg.content ?? "");
    if (question !== null) {
      const fromGM = !!msg.author?.isGM;
      // Игроки могут звать ассистента, только если ГМ это разрешил.
      if (!fromGM && setting("assistantAccess") !== "all") return;
      if (setting("claudeQueue")) {
        enqueue("вопрос", {
          messageId: msg.id,
          from: msg.author?.name,
          as: msg.speaker?.alias,
          isGM: fromGM || undefined,
          // Куда отвечать: ГМу — шёпотом, игроку — всем (так решил ГМ в настройках).
          reply: fromGM ? "gm" : "all",
          text: question,
        });
      }
      return;
    }
  }

  // 2. Урон.
  if (msg.isDamageRoll) return handleDamage(msg, ctx, item);

  // 3. Действия навыков с исходом.
  if (ctx?.type === "skill-check" && ctx.outcome) return handleAction(msg, ctx);

  // 4. Результат спасброска.
  if (ctx?.type === "saving-throw" && ctx.outcome) return handleSave(msg, ctx, item);

  // 5. Заклинание со спасброском применено к целям.
  if (!ctx && !msg.rolls?.length && item?.type === "spell") return handleSpellCast(msg, item);
}

async function handleDamage(msg, ctx, item) {
  const mode = setting("autoDamage");
  if (mode === "off" || msg.flags?.[MODULE_ID]?.damageApplied) return;
  const roll = msg.rolls[0];
  const targets = targetsOf(msg).filter((t) => t.actor && (mode === "all" || npcOnly(t.actor)));
  if (!targets.length) return;

  const save = item?.system?.defense?.save;
  const rollOptions = new Set(ctx?.options ?? []);
  for (const token of targets) {
    let multiplier = 1;
    if (item?.type === "spell" && save?.statistic) {
      const outcome = recallSave(item.uuid, token.uuid);
      if (!outcome) {
        if (setting("claudeQueue")) enqueue("урон без спасброска", { target: token.name, item: item.name, total: roll.total, note: "нет результата спасброска — урон не применён" });
        continue;
      }
      if (!save.basic) {
        if (setting("claudeQueue")) enqueue("урон: небазовый спасбросок", { target: token.name, item: item.name, total: roll.total, outcome: OUTCOME_RU[outcome] });
        continue;
      }
      multiplier = BASIC_SAVE_MULTIPLIER[outcome] ?? 1;
    }
    await applyRollDamage(token.actor, token, roll, multiplier, { item, rollOptions });
  }
  if (msg.isOwner) await msg.setFlag(MODULE_ID, "damageApplied", true);
}

async function handleAction(msg, ctx) {
  const slug = actionSlug(msg);
  if (!slug) return;
  const rules = ACTION_RULES[slug]?.[ctx.outcome];
  const self = msg.actor;
  const target = targetsOf(msg)[0]?.actor;

  if (!rules) {
    // В очередь — только действия против другого существа и не из списка небоевых.
    const noise = NON_COMBAT_ACTIONS.has(slug) || !target || target === self || target.id === self?.id;
    if (setting("claudeQueue") && !noise && ["criticalSuccess", "success", "criticalFailure"].includes(ctx.outcome) && !ACTION_RULES[slug]) {
      enqueue("действие", { who: self?.name, action: slug, target: target.name, outcome: OUTCOME_RU[ctx.outcome] });
    }
    return;
  }
  if (!setting("autoActionConditions")) return;

  for (const [who, cond, value] of rules) {
    const actor = who === "self" ? self : target;
    if (!actor) continue;
    if (cond.startsWith("-")) await setCondition(actor, cond.slice(1), 0);
    else await setCondition(actor, cond, value ?? true, { atLeast: true });
  }
}

async function handleSave(msg, ctx, item) {
  const sp = msg.speaker ?? {};
  const token = msg.token ?? (sp.token ? (game.scenes.get(sp.scene) ?? canvas.scene)?.tokens.get(sp.token) : null);
  if (item && token) rememberSave(item.uuid, token.uuid, ctx.outcome);
  if (item && setting("claudeQueue")) {
    enqueue("спасбросок", { who: msg.speaker?.alias, against: item.name, outcome: OUTCOME_RU[ctx.outcome], total: msg.rolls?.[0]?.total, dc: ctx.dc?.value });
  }
}

async function handleSpellCast(msg, spell) {
  if (!setting("autoNpcSaves")) return;
  const save = spell.system?.defense?.save;
  if (!save?.statistic) return;
  const dc = spell.spellcasting?.statistic?.dc?.value;
  if (!dc) return;
  const targets = targetsOf(msg).filter((t) => t.actor && npcOnly(t.actor));
  for (const token of targets) {
    const stat = token.actor.saves?.[save.statistic];
    if (!stat) continue;
    await stat.roll({ dc: { value: dc }, item: spell, origin: spell.actor, skipDialog: true });
  }
}
