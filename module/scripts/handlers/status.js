// Чат, очередь Claude, состояния, эффекты, урон и лечение.
import { requireScene, conditionsOf, hpOf } from "../util.js";
import { summarizeMessage } from "../chat.js";
import { takeQueue } from "../queue.js";
import { setCondition, damageActor, healActor, addEffect } from "../pf2e-ops.js";
import { track, undo, undoHistory } from "../undo.js";

let lastChatId = null;

/** Токены сцены по ID или имени. Имя должно быть однозначным. */
function findTokens(scene, refs) {
  return refs.map((ref) => {
    const byId = scene.tokens.get(ref);
    if (byId) return byId;
    const lower = ref.toLowerCase();
    let found = scene.tokens.filter((t) => t.name.toLowerCase() === lower);
    if (!found.length) found = scene.tokens.filter((t) => t.name.toLowerCase().includes(lower));
    if (found.length === 1) return found[0];
    if (!found.length) throw new Error(`На сцене «${scene.name}» нет токена «${ref}»`);
    throw new Error(`«${ref}» неоднозначно (${found.length} токенов) — укажите ID: ${found.map((t) => t.id).join(", ")}`);
  });
}

function tokenState(t) {
  const a = t.actor;
  const effects = (a?.itemTypes?.effect ?? []).map((e) => e.name);
  return {
    id: t.id, name: t.name, hp: hpOf(a),
    conditions: conditionsOf(a),
    effects: effects.length ? effects : undefined,
  };
}

// Частые русские синонимы, которых нет в переводе pf2e-ru.
const CONDITION_ALIASES = {
  "испуган": "frightened", "страх": "frightened",
  "сбит с ног": "prone", "лежит": "prone", "лежа": "prone",
  "застигнут": "off-guard", "врасплох": "off-guard",
  "захвачен": "grabbed", "в захвате": "grabbed",
  "ослабление": "enfeebled", "оглушён": "stunned", "оглушен": "stunned",
  "обездвижен": "immobilized", "удерживаем": "restrained", "сдерживаем": "restrained",
  "слеп": "blinded", "глух": "deafened", "тошнит": "sickened",
};

/** slug состояния по английскому slug, названию из перевода, синониму или началу слова. */
function conditionSlug(ref) {
  const types = CONFIG.PF2E?.conditionTypes ?? {};
  const r = ref.toLowerCase().trim().replace(/\s+\d+$/, "");
  if (types[r]) return r;
  if (CONDITION_ALIASES[r]) return CONDITION_ALIASES[r];
  const names = Object.entries(types).map(([slug, key]) => [slug, game.i18n.localize(key).toLowerCase()]);
  const exact = names.find(([, n]) => n === r);
  if (exact) return exact[0];
  const prefix = names.filter(([, n]) => r.length >= 4 && (n.startsWith(r) || r.startsWith(n.slice(0, Math.max(4, n.length - 2)))));
  if (prefix.length === 1) return prefix[0][0];
  throw new Error(`Неизвестное состояние: ${ref}. См. list-conditions (например: frightened — Напуган, prone — Ничком)`);
}

export const statusHandlers = {
  "get-chat": async ({ limit = 20, all = false, raw = false }) => {
    const msgs = game.messages.contents;
    let start = 0;
    if (!all && lastChatId) {
      const idx = msgs.findIndex((m) => m.id === lastChatId);
      if (idx >= 0) start = idx + 1;
    }
    const slice = msgs.slice(start).slice(-limit);
    if (msgs.length) lastChatId = msgs[msgs.length - 1].id;
    return { new: slice.length, messages: slice.map((m) => summarizeMessage(m, { raw })) };
  },

  "get-queue": async ({ peek = false }) => {
    const items = takeQueue({ peek });
    return { count: items.length, items };
  },

  "list-conditions": async () => {
    const types = CONFIG.PF2E?.conditionTypes ?? {};
    return Object.entries(types).map(([slug, key]) => `${slug} — ${game.i18n.localize(key)}`);
  },

  "set-condition": async ({ scene, tokens, condition, value }) => {
    const s = requireScene(scene);
    const slug = conditionSlug(condition);
    const results = [];
    for (const t of findTokens(s, tokens)) {
      await setCondition(t.actor, slug, value ?? true);
      results.push(tokenState(t));
    }
    return { condition: slug, tokens: results };
  },

  "search-effects": async ({ query, limit = 20 }) => {
    const q = query.toLowerCase();
    const results = [];
    for (const it of game.items.filter((i) => i.type === "effect" && i.name.toLowerCase().includes(q))) {
      results.push({ uuid: it.uuid, name: it.name, source: "мир" });
    }
    for (const pack of game.packs.filter((p) => p.documentName === "Item")) {
      const index = await pack.getIndex();
      for (const e of index) {
        if (e.type !== "effect") continue;
        if (!e.name.toLowerCase().includes(q)) continue;
        results.push({ uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`, name: e.name, source: pack.metadata.label });
      }
    }
    return { total: results.length, results: results.slice(0, limit) };
  },

  "apply-effect": async ({ scene, tokens, uuid, duration }) => {
    const s = requireScene(scene);
    const effect = await fromUuid(uuid);
    if (!effect || effect.type !== "effect") throw new Error(`Это не эффект pf2e: ${uuid}`);
    const results = [];
    for (const t of findTokens(s, tokens)) {
      await addEffect(t.actor, effect, { duration });
      results.push(tokenState(t));
    }
    return { effect: effect.name, tokens: results };
  },

  "remove-effect": async ({ scene, tokens, name }) => {
    const s = requireScene(scene);
    const q = name.toLowerCase();
    const results = [];
    for (const t of findTokens(s, tokens)) {
      const ids = (t.actor.itemTypes.effect ?? []).filter((e) => e.id === name || e.name.toLowerCase().includes(q)).map((e) => e.id);
      if (ids.length) { track(t.actor); await t.actor.deleteEmbeddedDocuments("Item", ids); }
      results.push({ ...tokenState(t), removed: ids.length });
    }
    return { tokens: results };
  },

  "apply-damage": async ({ scene, tokens, amount, type }) => {
    const s = requireScene(scene);
    const results = [];
    for (const t of findTokens(s, tokens)) {
      const r = await damageActor(t.actor, t, amount, type);
      results.push({ name: t.name, ...r, hp: hpOf(t.actor) });
    }
    return { amount, type: type ?? "без типа (без учёта сопротивлений)", tokens: results };
  },

  "heal": async ({ scene, tokens, amount }) => {
    const s = requireScene(scene);
    const results = [];
    for (const t of findTokens(s, tokens)) {
      const r = await healActor(t.actor, amount);
      results.push({ name: t.name, ...r });
    }
    return { tokens: results };
  },

  "send-chat-message": async ({ text, to = "gm", as, scene, replyTo }) => {
    const MODULE_ID = "pf2e-claude-bridge";
    const name = game.settings.get(MODULE_ID, "assistantName") || "Гриша";
    const html = text.split(/\n{2,}/).map((p) => `<p>${foundry.utils.escapeHTML?.(p) ?? p}</p>`).join("").replace(/\n/g, "<br>");

    let speaker = { alias: name };
    if (as) {
      const s = requireScene(scene);
      const [token] = findTokens(s, [as]);
      speaker = ChatMessage.getSpeaker({ token, scene: s });
    }

    const data = {
      content: html,
      speaker,
      flags: { [MODULE_ID]: { assistant: true, replyTo } },
    };
    if (to === "gm") data.whisper = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
    else if (to !== "all") {
      const user = game.users.getName(to) ?? game.users.find((u) => u.character?.name === to);
      if (!user) throw new Error(`Нет игрока «${to}» — укажите имя пользователя Foundry, имя его персонажа, "gm" или "all"`);
      data.whisper = [user.id, ...ChatMessage.getWhisperRecipients("GM").map((u) => u.id)];
    }
    if (!as) data.flavor = `<strong>${name}</strong>`;
    const msg = await ChatMessage.create(data);
    return { id: msg.id, to, speaker: speaker.alias };
  },

  "undo": async ({ id, steps = 1 }) => {
    const done = [];
    for (let i = 0; i < (id ? 1 : steps); i++) {
      const r = await undo(id ? { id } : {});
      if (!r) break;
      done.push(r);
    }
    return { undone: done, left: undoHistory(5) };
  },

  "undo-history": async ({ limit = 10 }) => ({ history: undoHistory(limit) }),

  "get-token-state": async ({ scene, tokens }) => {
    const s = requireScene(scene);
    return findTokens(s, tokens).map(tokenState);
  },
};
