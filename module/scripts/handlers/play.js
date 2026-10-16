// Действия за персонажей (заклинания) и добыча для мобов.
import { requireScene, hpOf, cellToXY, ensureEncounterFolder } from "../util.js";

/** Токены сцены по ID или имени (однозначному). */
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

const names = (doc) => [doc.name, doc.flags?.babele?.originalName, doc._source?.name].filter(Boolean).map((n) => n.toLowerCase());

/** Данные из компендиума — с переводом Babele (pf2e-ru), если он есть. */
async function localizedData(doc) {
  const data = doc.toObject();
  try {
    let tr = game.babele?.translate?.(doc.pack, data, false);
    if (tr instanceof Promise) tr = await tr;
    if (tr?.name) return tr;
  } catch { /* без перевода */ }
  return data;
}

const ITEM_TYPES = ["weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack"];
const TYPE_RU = { weapon: "оружие", armor: "доспех", shield: "щит", equipment: "снаряжение", consumable: "расходник", treasure: "ценность", backpack: "контейнер" };

function priceText(p) {
  const v = p?.value ?? p ?? {};
  const parts = ["pp", "gp", "sp", "cp"].filter((k) => v[k]).map((k) => `${v[k]} ${{ pp: "пм", gp: "зм", sp: "см", cp: "мм" }[k]}`);
  return parts.join(" ") || undefined;
}

export const playHandlers = {
  /**
   * Сотворить заклинание за персонажа/NPC по целям. Цели выделяются у ГМа, карточка заклинания
   * уходит в чат с этими целями — дальше автоматика модуля бросает спасброски NPC.
   */
  "cast-spell": async ({ scene, caster, spell, rank, targets = [] }) => {
    const s = requireScene(scene);
    const [casterToken] = findTokens(s, [caster]);
    const actor = casterToken.actor;
    if (!actor) throw new Error(`У токена «${casterToken.name}» нет актёра`);

    const q = spell.toLowerCase();
    const spells = actor.itemTypes.spell ?? [];
    const item = spells.find((sp) => names(sp).includes(q)) ?? spells.find((sp) => names(sp).some((n) => n.includes(q)));
    if (!item) {
      throw new Error(`У «${actor.name}» нет заклинания «${spell}». Есть: ${spells.map((sp) => sp.name).slice(0, 40).join(", ")}`);
    }

    const targetTokens = targets.length ? findTokens(s, targets) : [];
    if (canvas.scene?.id === s.id) {
      game.user.updateTokenTargets(targetTokens.map((t) => t.id));
    } else if (targetTokens.length) {
      throw new Error(`Чтобы выбрать цели, у ГМа должна быть открыта сцена «${s.name}»`);
    }

    const castRank = rank ?? item.rank;
    const entry = item.spellcasting;
    let via = "карточка";
    try {
      if (entry?.cast) {
        await entry.cast(item, { rank: castRank, consume: true });
        via = "заклинательная запись (с расходом ячейки/использования)";
      } else {
        await item.toMessage(undefined, { data: { castRank } });
      }
    } catch (e) {
      // Нет ячеек/использований — всё равно показываем карточку, чтобы ГМ решил сам.
      await item.toMessage(undefined, { data: { castRank } });
      via = `карточка без расхода (${e.message})`;
    }

    const save = item.system?.defense?.save;
    return {
      caster: actor.name,
      spell: item.name,
      rank: castRank,
      via,
      targets: targetTokens.map((t) => t.name),
      defense: save?.statistic ? `спасбросок ${save.statistic}${save.basic ? " (базовый)" : ""}` : (item.system?.defense?.passive?.statistic ?? "нет / атака заклинанием"),
      dc: entry?.statistic?.dc?.value,
      note: save?.statistic
        ? "Спасброски NPC-целей бросит автоматика модуля (если включена); исходы придут в очередь."
        : "Если это атака заклинанием или урон — бросок делается из карточки в чате.",
    };
  },

  /** Поиск предметов для добычи по названию, уровню и типу. */
  "search-items": async ({ query, minLevel, maxLevel, types, rarity, limit = 25 }) => {
    const q = query?.toLowerCase().trim();
    const wantTypes = types?.length ? types : ITEM_TYPES;
    const out = [];
    for (const pack of game.packs.filter((p) => p.documentName === "Item")) {
      const idx = await pack.getIndex({ fields: ["system.level.value", "system.price", "system.traits.rarity"] });
      for (const e of idx) {
        if (!wantTypes.includes(e.type)) continue;
        const level = e.system?.level?.value ?? 0;
        if (minLevel !== undefined && level < minLevel) continue;
        if (maxLevel !== undefined && level > maxLevel) continue;
        const rar = e.system?.traits?.rarity ?? "common";
        if (rarity && rar !== rarity) continue;
        if (q && ![e.name, e.originalName].filter(Boolean).some((n) => n.toLowerCase().includes(q))) continue;
        out.push({
          uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`,
          name: e.name, level, type: TYPE_RU[e.type] ?? e.type,
          price: priceText(e.system?.price),
          rarity: rar !== "common" ? rar : undefined,
        });
      }
    }
    out.sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
    return { total: out.length, results: out.slice(0, limit) };
  },

  /** Создать на сцене сундук (актёр pf2e «loot») и, при желании, сразу положить в него добычу. */
  "create-chest": async ({ scene, name = "Сундук", col, row, hidden = false, img }) => {
    const s = requireScene(scene);
    const folder = await ensureEncounterFolder();
    const actor = await Actor.implementation.create({
      name,
      type: "loot",
      img: img ?? "icons/containers/chest/chest-reinforced-steel-brown.webp",
      folder: folder.id,
      system: { lootSheetType: "Loot", hiddenWhenEmpty: false },
      prototypeToken: { name, actorLink: true, disposition: 0 },
    });
    const { x, y } = cellToXY(s, col, row);
    const td = await actor.getTokenDocument({ x, y, hidden });
    const [token] = await s.createEmbeddedDocuments("Token", [td.toObject()]);
    return { chestActorId: actor.id, tokenId: token.id, name, scene: s.name, col, row, hidden: hidden || undefined };
  },

  /**
   * Собрать добычу с мобов в сундук: переносит снаряжение, оружие, доспехи, расходники и монеты
   * (природные удары NPC не трогает). from — токены; пусто — все поверженные враги на сцене.
   */
  "collect-loot": async ({ scene, chest, from = [] }) => {
    const s = requireScene(scene);
    const [chestToken] = findTokens(s, [chest]);
    const target = chestToken.actor;
    if (!target) throw new Error(`У токена «${chestToken.name}» нет актёра`);

    const sources = from.length
      ? findTokens(s, from)
      : s.tokens.filter((t) => t.disposition === -1 && t.actor?.type === "npc" && (t.actor.system.attributes.hp?.value ?? 1) <= 0);
    if (!sources.length) throw new Error("Не с кого собирать: нет поверженных врагов на сцене (или укажите токены явно)");

    const report = [];
    for (const t of sources) {
      const a = t.actor;
      if (!a || a === target) continue;
      const loot = a.items.filter((i) => ITEM_TYPES.includes(i.type));
      if (!loot.length) { report.push({ from: t.name, items: [] }); continue; }
      const data = loot.map((i) => {
        const d = i.toObject();
        delete d._id;
        if (d.system) {
          d.system.equipped = { carryType: "worn", handsHeld: 0, inSlot: false };
          delete d.system.containerId;
        }
        return d;
      });
      await target.createEmbeddedDocuments("Item", data);
      await a.deleteEmbeddedDocuments("Item", loot.map((i) => i.id));
      report.push({ from: t.name, items: loot.map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`) });
    }
    return { chest: chestToken.name, collected: report };
  },

  /** Положить добычу в инвентарь моба или сундука: предметы из компендиума и монеты. */
  "add-loot": async ({ scene, token, items = [], coins }) => {
    const s = requireScene(scene);
    const [t] = findTokens(s, [token]);
    const actor = t.actor;
    if (!actor) throw new Error(`У токена «${t.name}» нет актёра`);

    const added = [];
    const missing = [];
    const data = [];
    for (const it of items) {
      const doc = it.uuid ? await fromUuid(it.uuid) : null;
      if (!doc) { missing.push(it.uuid ?? it.name); continue; }
      const d = await localizedData(doc);
      delete d._id;
      if (it.quantity && d.system) d.system.quantity = it.quantity;
      data.push(d);
      added.push(`${d.name}${it.quantity > 1 ? ` ×${it.quantity}` : ""}`);
    }
    if (data.length) await actor.createEmbeddedDocuments("Item", data);

    let coinText;
    if (coins && Object.values(coins).some((v) => v > 0)) {
      if (actor.inventory?.addCoins) await actor.inventory.addCoins(coins);
      else throw new Error("Эта версия pf2e не поддерживает добавление монет через API");
      coinText = priceText(coins);
    }
    return { token: t.name, added, coins: coinText, missing: missing.length ? missing : undefined, hp: hpOf(actor) };
  },
};
