// Операции над актёрами pf2e: состояния, эффекты, урон, лечение.
// Используются и инструментами Claude, и автоматикой.

/** Найти состояние на актёре по slug. */
export function getCondition(actor, slug) {
  return actor.getCondition?.(slug) ?? actor.itemTypes?.condition?.find((c) => c.slug === slug) ?? null;
}

/**
 * Установить состояние.
 *  value: число — точное значение (для «Испуган 2»), true — просто наложить, 0/false — снять.
 *  atLeast: только повышать (автоматика: «Испуган 1» не понижает уже имеющийся «Испуган 2»).
 */
export async function setCondition(actor, slug, value = true, { atLeast = false } = {}) {
  if (!actor?.increaseCondition) throw new Error(`${actor?.name ?? "?"}: актёр не поддерживает состояния pf2e`);
  let cond = getCondition(actor, slug);

  if (value === 0 || value === false) {
    if (cond) await actor.decreaseCondition(slug, { forceRemove: true });
    return { name: slug, removed: !!cond };
  }

  if (!cond) {
    await actor.increaseCondition(slug);
    cond = getCondition(actor, slug);
    if (!cond) throw new Error(`Неизвестное состояние pf2e: ${slug}`);
  }

  if (typeof value === "number" && cond.system?.value?.isValued) {
    const cur = cond.value ?? cond.system.value.value ?? 1;
    const next = atLeast ? Math.max(cur, value) : value;
    if (next !== cur) await cond.update({ "system.value.value": next });
  }
  cond = getCondition(actor, slug);
  return { name: cond?.name ?? slug, value: cond?.value ?? undefined };
}

/** Класс DamageRoll системы pf2e. */
function DamageRollClass() {
  return CONFIG.Dice.rolls.find((r) => r.name === "DamageRoll");
}

/**
 * Урон с учётом IWR (если указан тип). amount < 0 не допускается — для лечения healActor.
 * token — TokenDocument (нужен pf2e для правильного синтетического актёра и сообщения).
 */
export async function damageActor(actor, token, amount, type, { item, rollOptions } = {}) {
  let damage = amount;
  if (type) {
    const DamageRoll = DamageRollClass();
    if (!DamageRoll) throw new Error("Не найден DamageRoll системы pf2e");
    damage = await new DamageRoll(`${amount}[${type}]`).evaluate();
  }
  const before = actor.system.attributes.hp?.value;
  await actor.applyDamage({ damage, token, item, rollOptions: rollOptions ?? new Set() });
  const after = actor.system.attributes.hp?.value;
  return { hpBefore: before, hpAfter: after, dealt: before - after };
}

export async function healActor(actor, amount) {
  const hp = actor.system.attributes.hp;
  const next = Math.min(hp.max, hp.value + amount);
  await actor.update({ "system.attributes.hp.value": next });
  return { hpBefore: hp.value, hpAfter: next };
}

/** Наложить эффект (Item type=effect) на актёра. */
export async function addEffect(actor, effectDoc, { duration } = {}) {
  const data = effectDoc.toObject();
  delete data._id;
  foundry.utils.setProperty(data, "_stats.compendiumSource", effectDoc.uuid);
  if (duration) {
    data.system.duration = { ...(data.system.duration ?? {}), value: duration.value, unit: duration.unit, expiry: data.system.duration?.expiry ?? "turn-start" };
  }
  const [created] = await actor.createEmbeddedDocuments("Item", [data]);
  return { id: created.id, name: created.name };
}

/** Обёртка: урон из карточки урона pf2e (с учётом степени успеха базового спасброска). */
export async function applyRollDamage(actor, token, roll, multiplier, { item, rollOptions } = {}) {
  if (multiplier === 0) return { dealt: 0, skipped: "крит. успех спасброска" };
  const damage = multiplier === 1 ? roll : roll.alter(multiplier, 0);
  const before = actor.system.attributes.hp?.value;
  await actor.applyDamage({ damage, token, item, rollOptions: rollOptions ?? new Set() });
  return { hpBefore: before, hpAfter: actor.system.attributes.hp?.value };
}
