// Отмена действий автоматики и Claude: урон, лечение, состояния, эффекты.
//
// Операции оборачиваются в undoGroup(); каждая функция из pf2e-ops перед изменением актёра
// вызывает track(actor) — снимок «до». В конце группы снимаем «после».
// Отмена работает дельтой: HP возвращается на столько, на сколько его изменила операция,
// созданные ей состояния/эффекты удаляются, удалённые — восстанавливаются. Поэтому более поздние
// изменения того же актёра (следующий удар) не затираются.
// История хранится в памяти вкладки ГМа (последние 30), после перезагрузки пропадает.
import { MODULE_ID } from "./util.js";

const MAX = 30;
const stack = [];
let current = null;

const TRACKED = new Set(["condition", "effect"]);

function snap(actor) {
  const hp = actor.system?.attributes?.hp ?? {};
  const items = {};
  for (const i of actor.items) {
    if (TRACKED.has(i.type)) items[i.id] = i.toObject();
  }
  return { hp: hp.value ?? 0, temp: hp.temp ?? 0, items };
}

/** Запомнить состояние актёра до изменения (вызывается из pf2e-ops). */
export function track(actor) {
  if (!current || !actor?.uuid || current.snaps.has(actor.uuid)) return;
  current.snaps.set(actor.uuid, { uuid: actor.uuid, name: actor.name, before: snap(actor) });
}

/** Выполнить fn как одну отменяемую операцию. Вложенные группы сливаются во внешнюю. */
export async function undoGroup(label, fn, { messageId } = {}) {
  if (current) return fn();
  current = { label, messageIds: [].concat(messageId ?? []), snaps: new Map() };
  try {
    return await fn();
  } finally {
    const g = current;
    current = null;
    const snaps = [...g.snaps.values()];
    for (const s of snaps) {
      const a = fromUuidSync(s.uuid);
      s.after = a ? snap(a) : s.before;
    }
    const changed = snaps.filter((s) => s.after.hp !== s.before.hp || s.after.temp !== s.before.temp
      || JSON.stringify(Object.keys(s.after.items).sort()) !== JSON.stringify(Object.keys(s.before.items).sort())
      || Object.keys(s.after.items).some((id) => valueOf(s.after.items[id]) !== valueOf(s.before.items[id])));
    if (changed.length) {
      stack.push({ id: foundry.utils.randomID(), label: g.label, messageIds: g.messageIds, at: Date.now(), snaps: changed });
      while (stack.length > MAX) stack.shift();
      Hooks.callAll(`${MODULE_ID}.undo`, stack.length);
    }
  }
}

const valueOf = (item) => item?.system?.value?.value ?? null;

function describe(e) {
  return {
    id: e.id,
    label: e.label,
    at: new Date(e.at).toLocaleTimeString("ru-RU"),
    targets: e.snaps.map((s) => {
      const parts = [];
      const dhp = s.after.hp - s.before.hp;
      if (dhp) parts.push(`HP ${dhp > 0 ? "+" : ""}${dhp}`);
      const dt = s.after.temp - s.before.temp;
      if (dt) parts.push(`врем. HP ${dt > 0 ? "+" : ""}${dt}`);
      for (const [id, it] of Object.entries(s.after.items)) {
        if (!s.before.items[id]) parts.push(`+${it.name}`);
        else if (valueOf(it) !== valueOf(s.before.items[id])) parts.push(`${it.name} ${valueOf(s.before.items[id])}→${valueOf(it)}`);
      }
      for (const [id, it] of Object.entries(s.before.items)) if (!s.after.items[id]) parts.push(`−${it.name}`);
      return `${s.name}: ${parts.join(", ")}`;
    }),
  };
}

export function undoHistory(limit = 10) {
  return stack.slice(-limit).reverse().map(describe);
}

export function hasUndoFor(messageId) {
  return stack.some((e) => e.messageIds.includes(messageId));
}

/** Отменить: последнюю операцию, по id или последнюю для сообщения чата. */
export async function undo({ id, messageId } = {}) {
  let idx = -1;
  if (id) idx = stack.findIndex((e) => e.id === id);
  else if (messageId) idx = stack.findLastIndex((e) => e.messageIds.includes(messageId));
  else idx = stack.length - 1;
  if (idx < 0) return null;
  const [entry] = stack.splice(idx, 1);

  for (const s of entry.snaps) {
    const actor = fromUuidSync(s.uuid);
    if (!actor) continue;
    const hp = actor.system.attributes?.hp;
    if (hp) {
      const value = Math.clamp(hp.value - (s.after.hp - s.before.hp), 0, hp.max);
      const temp = Math.max(0, (hp.temp ?? 0) - (s.after.temp - s.before.temp));
      if (value !== hp.value || temp !== (hp.temp ?? 0)) {
        await actor.update({ "system.attributes.hp.value": value, "system.attributes.hp.temp": temp });
      }
      // NPC снова жив — снять «мёртв» и «повержен», которые поставила автоматика.
      if (value > 0 && s.before.hp > 0 && hp.value <= 0) {
        await actor.toggleStatusEffect?.("dead", { active: false }).catch(() => {});
        for (const c of game.combat?.combatants.filter((c) => c.actor === actor && c.defeated) ?? []) await c.update({ defeated: false });
      }
    }
    // Созданное операцией — удалить (если ещё есть).
    const created = Object.keys(s.after.items).filter((iid) => !s.before.items[iid] && actor.items.get(iid));
    if (created.length) await actor.deleteEmbeddedDocuments("Item", created);
    // Удалённое операцией — вернуть.
    const removed = Object.entries(s.before.items).filter(([iid]) => !s.after.items[iid] && !actor.items.get(iid)).map(([, d]) => d);
    if (removed.length) await actor.createEmbeddedDocuments("Item", removed, { keepId: true });
    // Изменённое значение (Испуган 1→2) — вернуть, если с тех пор не трогали.
    for (const [iid, after] of Object.entries(s.after.items)) {
      const before = s.before.items[iid];
      const item = actor.items.get(iid);
      if (before && item && valueOf(before) !== valueOf(after) && item.system?.value?.value === valueOf(after)) {
        await item.update({ "system.value.value": valueOf(before) });
      }
    }
  }
  Hooks.callAll(`${MODULE_ID}.undo`, stack.length);
  return describe(entry);
}
