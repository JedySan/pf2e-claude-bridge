// Черты, которые сравнивают проверку с КС Воли каждой цели отдельно.
export const DEGREE_KEYS = ["criticalFailure", "failure", "success", "criticalSuccess"];

/** Степень успеха 0–3 с поправкой за натуральные 20 и 1. */
export function degreeOf(total, dc, natural) {
  let d = total >= dc + 10 ? 3 : total >= dc ? 2 : total > dc - 10 ? 1 : 0;
  if (natural === 20) d = Math.min(3, d + 1);
  if (natural === 1) d = Math.max(0, d - 1);
  return d;
}

/** Недееспособность: цель выше удвоенного ранга (половина уровня, вверх) снижает исход на шаг. */
export function incapacitation(degree, userLevel, targetLevel) {
  return targetLevel > 2 * Math.ceil(userLevel / 2) ? Math.max(0, degree - 1) : degree;
}

const DAZZLED_ROUND = { slug: "dazzled", rounds: 1 };

export const FEAT_RULES = {
  // Расцветание пиона (Peony's Flourish).
  peony: {
    incapacitation: () => true,
    effects: (degree) => ({
      3: [{ slug: "stunned", value: 3 }, { slug: "dazzled", whileCondition: "stunned" }],
      2: [{ slug: "stunned", value: 1 }, DAZZLED_ROUND],
      1: [DAZZLED_ROUND],
      0: [],
    })[degree],
    note: (degree) => (degree === 0 ? "иммунитет к Расцветанию на 24 часа" : null),
  },
  // Захватывающее выступление (Fascinating Performance): в бою нужен крит и есть недееспособность.
  fascinating: {
    incapacitation: (inCombat) => inCombat,
    effects: (degree, inCombat) => (degree >= (inCombat ? 3 : 2) ? [{ slug: "fascinated", rounds: 1 }] : []),
    note: () => "иммунитет к этому выступлению на 1 час",
  },
};

/** Какое правило относится к проверке навыка. */
export function featRuleKey(slug, options = []) {
  if (slug === "peonys-flourish") return "peony";
  if (slug === "perform" && options.includes("feat:fascinating-performance")) return "fascinating";
  return null;
}
