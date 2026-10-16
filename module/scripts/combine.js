// Объединение урона нескольких Ударов (Двойной разрез, Шквал ударов, Двойное убийство…).
// По правилам урон таких Ударов по одной цели складывается ДО сопротивлений и слабостей:
// сопротивление 5 к рубящему вычитается один раз из суммы, а не из каждого удара.
//
// Как работает: карточка такого действия в чате «взводит» объединение для существа.
// Следующие две атаки этого существа отслеживаются; урон по попавшим копится и применяется
// одним броском, как только пришли все ожидаемые броски урона (или по таймауту).

const ARM_MS = 90 * 1000;       // сколько ждать атак после карточки действия
const FLUSH_MS = 40 * 1000;     // сколько ждать второй бросок урона
const STRIKES = 2;

export const DEFAULT_COMBINE_ACTIONS =
  "double-slice, flurry-of-blows, twin-takedown, paired-shots, Двойной разрез, Шквал ударов, Двойное убийство";

/** Совпадает ли предмет-источник карточки со списком действий из настроек. */
export function isCombineAction(item, listSetting) {
  if (!item) return false;
  const names = listSetting.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const keys = [item.slug, item.name, item.flags?.babele?.originalName]
    .filter(Boolean).map((s) => String(s).toLowerCase());
  return keys.some((k) => names.includes(k));
}

/**
 * Сложить броски урона в части формулы: одинаковые типы суммируются в один экземпляр,
 * чтобы сопротивление/слабость сработали один раз. Продолжительный урон не складывается.
 * Возвращает строку формулы pf2e вида «{12[slashing],3[fire]}».
 */
export function combinedFormula(rolls) {
  const sums = new Map();
  const persistent = [];
  for (const roll of rolls) {
    for (const inst of roll.instances ?? []) {
      if (inst.persistent) {
        const f = String(inst.formula ?? inst.total).replace(/\[[^\]]*\]$/, "");
        persistent.push(`(${f})[persistent,${inst.type}]`);
        continue;
      }
      const key = inst.type ?? "untyped";
      sums.set(key, (sums.get(key) ?? 0) + (inst.total ?? 0));
    }
  }
  const parts = [...sums].filter(([, v]) => v > 0).map(([t, v]) => (t === "untyped" ? `${v}` : `${v}[${t}]`));
  parts.push(...persistent);
  return parts.length ? `{${parts.join(",")}}` : null;
}

/** Состояние объединения по существам: uuid актёра → сессия. */
const sessions = new Map();

function keyOf(actor) {
  return actor?.uuid ?? null;
}

function alive(s) {
  return s && Date.now() < s.until;
}

export function armCombine(actor, label) {
  const key = keyOf(actor);
  if (!key) return;
  const old = sessions.get(key);
  if (old?.timer) clearTimeout(old.timer);
  sessions.set(key, { label, until: Date.now() + ARM_MS, attacks: 0, hits: 0, damage: [], timer: null });
}

/** Учесть бросок атаки. Возвращает true, если пора применять накопленное. */
export function noteAttack(actor, outcome, flush) {
  const key = keyOf(actor);
  const s = sessions.get(key);
  if (!alive(s)) return;
  s.attacks += 1;
  if (outcome === "success" || outcome === "criticalSuccess") s.hits += 1;
  if (s.attacks >= STRIKES) {
    if (s.hits === 0) return sessions.delete(key);
    if (s.damage.length >= s.hits) return finish(key, flush);
  }
}

/**
 * Перехватить бросок урона, если для существа взведено объединение.
 * entry = { msg, roll, targets, item, rollOptions }. Возвращает true, если урон забран в объединение.
 */
export function takeDamage(actor, entry, flush) {
  const key = keyOf(actor);
  const s = sessions.get(key);
  if (!alive(s)) return false;
  s.damage.push(entry);
  if (s.timer) clearTimeout(s.timer);
  const expected = s.attacks >= STRIKES ? Math.max(s.hits, 1) : STRIKES;
  if (s.damage.length >= expected) finish(key, flush);
  else s.timer = setTimeout(() => finish(key, flush), FLUSH_MS);
  return true;
}

function finish(key, flush) {
  const s = sessions.get(key);
  sessions.delete(key);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  if (s.damage.length) flush(s.damage, s.label);
}

/** Разложить накопленные броски по целям: uuid токена → { token, entries[] }. */
export function groupByTarget(entries) {
  const byTarget = new Map();
  for (const e of entries) {
    for (const t of e.targets) {
      const g = byTarget.get(t.uuid) ?? { token: t, entries: [] };
      g.entries.push(e);
      byTarget.set(t.uuid, g);
    }
  }
  return [...byTarget.values()];
}
