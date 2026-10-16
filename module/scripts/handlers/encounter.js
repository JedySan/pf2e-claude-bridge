// Компендиумы, актёры и бюджет энкаунтера.
import {
  getProp, findActor, requireScene, stripHtml, hpOf, conditionsOf, ensureEncounterFolder, ENCOUNTER_FOLDER,
} from "../util.js";

// ---------- Бюджет XP (Pathfinder 2e, GM Core) ----------

const XP_BY_DIFF = { [-4]: 10, [-3]: 15, [-2]: 20, [-1]: 30, 0: 40, 1: 60, 2: 80, 3: 120, 4: 160 };
const THREATS = [
  // название, бюджет на 4 героев, поправка за каждого героя сверх/меньше 4
  { key: "trivial", ru: "Тривиальная", base: 40, adj: 10 },
  { key: "low", ru: "Низкая", base: 60, adj: 15 },
  { key: "moderate", ru: "Средняя", base: 80, adj: 20 },
  { key: "severe", ru: "Высокая", base: 120, adj: 30 },
  { key: "extreme", ru: "Экстремальная", base: 160, adj: 40 },
];

export function creatureXP(creatureLevel, partyLevel) {
  const diff = creatureLevel - partyLevel;
  if (diff < -4) return { xp: 0, note: "слишком слабое — 0 XP" };
  if (diff > 4) return { xp: 160 + (diff - 4) * 40, note: "уровень выше партии +4 — опасно даже в одиночку" };
  return { xp: XP_BY_DIFF[diff] };
}

export function budgetTable(partySize) {
  return Object.fromEntries(THREATS.map((t) => [t.key, t.base + (partySize - 4) * t.adj]));
}

export function threatOf(xp, partySize) {
  const b = budgetTable(partySize);
  if (xp > b.extreme * 1.25) return "за гранью Экстремальной";
  let label = "ниже Тривиальной";
  for (const t of THREATS) if (xp >= b[t.key]) label = t.ru;
  return label;
}

function partyFromScene(scene) {
  return scene.tokens
    .filter((t) => t.actor?.type === "character" && t.disposition === 1)
    .map((t) => t.actor);
}

function partyFromWorld() {
  const members = game.actors.party?.members ?? [];
  return members.filter((a) => a.type === "character");
}

// ---------- Компактный стат-блок ----------

function speedsOf(actor) {
  const sp = actor.system?.movement?.speeds;
  if (sp) {
    return Object.values(sp)
      .filter((s) => s && s.value && s.type !== "travel")
      .map((s) => `${s.type === "land" ? "" : s.type + " "}${s.value}`).join(", ");
  }
  const old = actor.system?.attributes?.speed;
  if (!old) return undefined;
  return [old.value, ...(old.otherSpeeds ?? []).map((o) => `${o.type} ${o.value}`)].join(", ");
}

function iwrOf(actor) {
  const a = actor.attributes ?? actor.system?.attributes ?? {};
  const fmt = (list, withValue) => (list ?? []).map((x) => (withValue && x.value ? `${x.type} ${x.value}` : x.type));
  const out = {};
  const imm = fmt(a.immunities, false); if (imm.length) out.immunities = imm;
  const wk = fmt(a.weaknesses, true); if (wk.length) out.weaknesses = wk;
  const res = fmt(a.resistances, true); if (res.length) out.resistances = res;
  return out;
}

function strikesOf(actor) {
  return (actor.system?.actions ?? [])
    .filter((s) => s.type === "strike")
    .map((s) => {
      const dmg = Object.values(s.item?.system?.damageRolls ?? {})
        .map((d) => `${d.damage} ${d.category === "persistent" ? "продолж. " : ""}${d.damageType}`).join(" + ");
      const traits = (s.item?.system?.traits?.value ?? []).filter((t) => t !== "attack");
      return {
        name: s.label,
        ranged: s.item?.isRanged || s.attackRollType === "PF2E.NPCAttackRanged" || undefined,
        attack: s.variants?.map((v) => v.label.replace(/^[^+-\d]*/, "")).join(" / ") || `+${s.totalModifier}`,
        damage: dmg || undefined,
        traits: traits.length ? traits.join(", ") : undefined,
      };
    });
}

const ACTION_GLYPH = { reaction: "⟲", free: "◇", passive: "пассив" };

/** Описания некоторых способностей — ключи локализации (PF2E.NPC.Abilities.Glossary.Wavesense). */
function localizeKeys(text) {
  if (!text) return text;
  return String(text).replace(/PF2E\.[A-Za-z0-9.]+/g, (k) => (game.i18n.has(k) ? game.i18n.localize(k) : k));
}

function abilitiesOf(actor, descMax) {
  return actor.itemTypes.action.map((i) => {
    const t = i.system.actionType?.value;
    const cost = t === "action" ? `${i.system.actions?.value ?? 1}д` : ACTION_GLYPH[t] ?? t;
    const traits = i.system.traits?.value ?? [];
    return {
      name: i.name,
      cost,
      traits: traits.length ? traits.join(", ") : undefined,
      text: descMax === 0 ? undefined : stripHtml(localizeKeys(i.system.description?.value), descMax) || undefined,
    };
  });
}

function spellsOf(actor) {
  const entries = actor.itemTypes.spellcastingEntry ?? [];
  if (!entries.length) return undefined;
  return entries.map((e) => {
    const spells = actor.itemTypes.spell.filter((sp) => sp.system.location?.value === e.id);
    const byRank = {};
    for (const sp of spells) {
      const r = sp.isCantrip ? "фокусы" : String(sp.system.location?.heightenedLevel ?? sp.rank ?? sp.system.level?.value);
      (byRank[r] ??= []).push(sp.name);
    }
    return {
      name: e.name,
      dc: e.statistic?.dc?.value ?? e.system?.spelldc?.dc,
      attack: e.statistic?.check?.mod ?? e.system?.spelldc?.value,
      spells: byRank,
    };
  });
}

function skillsOf(actor) {
  const sk = actor.system?.skills ?? {};
  // У NPC в исходных данных перечислены только навыки из стат-блока — остальное система
  // достраивает от характеристик. Показываем только их. У героев — с рангом > 0.
  const listed = actor.type === "npc" ? new Set(Object.keys(actor._source?.system?.skills ?? {})) : null;
  const out = {};
  for (const [slug, s] of Object.entries(sk)) {
    if (s?.visible === false) continue;
    if (listed?.size && !listed.has(slug) && !s?.lore) continue;
    if (!listed && actor.type === "character" && !(s?.rank > 0)) continue;
    const mod = s?.mod ?? s?.totalModifier ?? s?.base ?? s?.value;
    if (typeof mod === "number") out[s.label ?? slug] = mod;
  }
  return out;
}

export function statBlock(actor, { descMax = 200 } = {}) {
  const sys = actor.system ?? {};
  const saves = actor.saves ?? {};
  return {
    id: actor.id,
    uuid: actor.uuid,
    name: actor.name,
    type: actor.type,
    level: actor.level,
    rarity: sys.traits?.rarity,
    size: sys.traits?.size?.value,
    traits: sys.traits?.value,
    hp: hpOf(actor),
    ac: sys.attributes?.ac?.value,
    saves: {
      fort: saves.fortitude?.mod ?? sys.saves?.fortitude?.value,
      ref: saves.reflex?.mod ?? sys.saves?.reflex?.value,
      will: saves.will?.mod ?? sys.saves?.will?.value,
    },
    perception: actor.perception?.mod ?? sys.perception?.mod,
    senses: (sys.perception?.senses ?? []).map((s) => {
      const label = s.label ?? s.type;
      const ranged = Number.isFinite(s.range) && s.range > 0 && !String(label).includes(String(s.range));
      return ranged ? `${label} ${s.range} фт` : label;
    }),
    speed: speedsOf(actor),
    ...iwrOf(actor),
    skills: skillsOf(actor),
    strikes: strikesOf(actor),
    abilities: abilitiesOf(actor, descMax),
    spellcasting: spellsOf(actor),
    conditions: conditionsOf(actor).length ? conditionsOf(actor) : undefined,
  };
}

// ---------- Обработчики ----------

const INDEX_FIELDS = ["system.details.level.value", "system.traits.value", "system.traits.rarity", "system.traits.size.value"];

export const encounterHandlers = {
  "search-compendium": async ({ query, minLevel, maxLevel, traits, rarity, limit = 25 }) => {
    const q = query?.toLowerCase().trim();
    const wantTraits = (traits ?? []).map((t) => t.toLowerCase());
    const results = [];
    const packs = game.packs.filter((p) => p.documentName === "Actor");
    for (const pack of packs) {
      const index = await pack.getIndex({ fields: INDEX_FIELDS });
      for (const e of index) {
        if (e.type !== "npc") continue;
        const level = getProp(e, "system.details.level.value");
        if (minLevel !== undefined && (level ?? -99) < minLevel) continue;
        if (maxLevel !== undefined && (level ?? 99) > maxLevel) continue;
        const tr = getProp(e, "system.traits.value") ?? [];
        if (wantTraits.length && !wantTraits.every((t) => tr.includes(t))) continue;
        const rar = getProp(e, "system.traits.rarity");
        if (rarity && rar !== rarity) continue;
        if (q) {
          const names = [e.name, e.originalName, getProp(e, "flags.babele.originalName")].filter(Boolean);
          if (!names.some((n) => n.toLowerCase().includes(q))) continue;
        }
        results.push({
          uuid: e.uuid ?? `Compendium.${pack.collection}.Actor.${e._id}`,
          name: e.name,
          level,
          rarity: rar !== "common" ? rar : undefined,
          size: getProp(e, "system.traits.size.value"),
          traits: tr.join(", "),
          pack: pack.metadata.label,
        });
      }
    }
    results.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
    return { total: results.length, shown: Math.min(limit, results.length), results: results.slice(0, limit) };
  },

  "get-actor": async ({ ref, descMax }) => {
    const actor = ref?.startsWith("Compendium.") || ref?.startsWith("Actor.") ? await fromUuid(ref) : findActor(ref);
    if (!actor) throw new Error(`Актёр не найден: ${ref}`);
    return statBlock(actor, { descMax });
  },

  "import-actor": async ({ uuid, name, adjustment, count = 1 }) => {
    const src = await fromUuid(uuid);
    if (!src || src.documentName !== "Actor" || !src.pack) throw new Error(`В компендиуме не найден актёр: ${uuid}`);
    const pack = game.packs.get(src.pack);
    const folder = await ensureEncounterFolder();
    const baseName = name ?? src.name;

    const created = [];
    for (let i = 0; i < count; i++) {
      const update = { folder: folder.id };
      if (name || count > 1) update.name = count > 1 ? `${baseName} ${i + 1}` : baseName;
      // Штатный импорт: его перехватывают Babele / pf2e-ru и отдают переведённого актёра.
      const actor = await game.actors.importFromCompendium(pack, src.id, update);
      if (adjustment && adjustment !== "normal") {
        if (typeof actor.applyAdjustment !== "function") throw new Error("Эта версия pf2e не поддерживает Elite/Weak через API");
        await actor.applyAdjustment(adjustment);
      }
      created.push({ id: actor.id, name: actor.name, level: actor.level, hp: hpOf(actor), ac: actor.system.attributes.ac?.value });
    }
    return { folder: ENCOUNTER_FOLDER, created };
  },

  "list-actors": async ({ query, type, folder }) => {
    const q = query?.toLowerCase();
    const f = folder === "encounter" ? game.folders.find((x) => x.type === "Actor" && x.name === ENCOUNTER_FOLDER) : null;
    return game.actors
      .filter((a) => (!type || a.type === type) && (!q || a.name.toLowerCase().includes(q)) && (!f || a.folder?.id === f.id))
      .map((a) => ({ id: a.id, name: a.name, type: a.type, level: a.level, folder: a.folder?.name }));
  },

  "delete-actors": async ({ ids }) => {
    const refused = [];
    const toDelete = [];
    for (const id of ids) {
      const a = findActor(id);
      if (!a) { refused.push({ id, reason: "не найден" }); continue; }
      if (a.type === "character" || a.hasPlayerOwner) { refused.push({ id, name: a.name, reason: "персонаж игрока — не удаляю" }); continue; }
      toDelete.push(a.id);
    }
    const deleted = toDelete.length ? await Actor.implementation.deleteDocuments(toDelete) : [];
    return { deleted: deleted.map((a) => a.name), refused: refused.length ? refused : undefined };
  },

  "encounter-budget": async ({ scene, partyLevel, partySize, creatures }) => {
    // Партия: явно → герои на сцене → партия мира.
    let party = [];
    let s = null;
    if (scene || !creatures) s = requireScene(scene);
    if (partyLevel === undefined || partySize === undefined) {
      party = s ? partyFromScene(s) : [];
      if (!party.length) party = partyFromWorld();
    }
    const level = partyLevel ?? (party.length ? Math.round(party.reduce((n, a) => n + a.level, 0) / party.length) : undefined);
    const size = partySize ?? party.length;
    if (level === undefined || !size) throw new Error("Не удалось определить партию — укажите partyLevel и partySize");

    const rows = [];
    let visibleXP = 0;
    let hiddenXP = 0;
    if (creatures?.length) {
      for (const c of creatures) {
        const { xp, note } = creatureXP(c.level, level);
        const n = c.count ?? 1;
        rows.push({ name: c.name, level: c.level, count: n, xpEach: xp, xp: xp * n, note });
        visibleXP += xp * n;
      }
    } else {
      const enemies = s.tokens.filter((t) => t.disposition === -1 && t.actor?.type !== "character"
        && (t.actor?.system?.attributes?.hp?.value ?? 1) > 0);
      const groups = new Map();
      for (const t of enemies) {
        const key = `${t.actor.name}|${t.actor.level}|${t.hidden}`;
        const g = groups.get(key) ?? { name: t.actor.name, level: t.actor.level, hidden: t.hidden, count: 0 };
        g.count++;
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        const { xp, note } = creatureXP(g.level, level);
        rows.push({ name: g.name, level: g.level, count: g.count, hidden: g.hidden || undefined, xpEach: xp, xp: xp * g.count, note });
        if (g.hidden) hiddenXP += xp * g.count; else visibleXP += xp * g.count;
      }
    }

    const out = {
      party: { level, size, members: party.length ? party.map((a) => `${a.name} (${a.level})`) : undefined },
      budgets: budgetTable(size),
      creatures: rows,
      totalXP: visibleXP,
      threat: threatOf(visibleXP, size),
    };
    if (hiddenXP) {
      out.hiddenXP = hiddenXP;
      out.withHidden = { totalXP: visibleXP + hiddenXP, threat: threatOf(visibleXP + hiddenXP, size) };
    }
    return out;
  },
};
