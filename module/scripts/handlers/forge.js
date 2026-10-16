// Интеграция с модулем «PF2e Кузня существ» (jedysan-kuznya) через его API.

function forgeApi() {
  const mod = game.modules.get("jedysan-kuznya");
  if (!mod?.active) throw new Error("Модуль «PF2e Кузня существ» не установлен или не включён в мире");
  if (!mod.api) throw new Error("Кузня существ ещё загружается — повторите через пару секунд");
  return mod.api;
}

/** Если указана роль — сначала шаблон роли, потом поверх явные поля спецификации. */
function withRole(api, spec) {
  if (!spec.role) return spec;
  const base = api.applyRole(api.emptySpec(spec.level ?? 1), spec.role);
  const merged = { ...base, ...spec };
  merged.attributes = { ...base.attributes, ...(spec.attributes ?? {}) };
  merged.saves = { ...base.saves, ...(spec.saves ?? {}) };
  return merged;
}

export const forgeHandlers = {
  "forge-roles": async () => {
    const api = forgeApi();
    return api.roles();
  },

  "forge-preview": async ({ spec }) => {
    const api = forgeApi();
    const stats = api.preview(withRole(api, spec));
    return {
      level: stats.level,
      attributes: stats.attributes,
      perception: stats.perception, ac: stats.ac, hp: stats.hp, saves: stats.saves,
      skills: stats.skills,
      strikes: stats.strikes.map((s) => ({ name: s.name, attack: `+${s.attack}`, damage: `${s.damage} ${s.damageType}`, average: s.average })),
      spellcasting: stats.spellcasting ? { dc: stats.spellcasting.dc, attack: stats.spellcasting.attack } : null,
      iwr: stats.iwr,
      warnings: stats.warnings,
    };
  },

  "forge-open": async ({ spec }) => {
    const api = forgeApi();
    api.open(withRole(api, spec));
    return { opened: true, note: "Мастер открыт у ГМа с заготовкой — ГМ проверит и нажмёт «Создать»" };
  },

  "forge-rescale": async ({ actorId, level, copy = false }) => {
    const api = forgeApi();
    if (!api.rescale) throw new Error("Обновите Кузню существ до версии со сменой уровня");
    const actor = game.actors.get(actorId) ?? game.actors.getName(actorId);
    if (!actor) throw new Error(`Актёр не найден: ${actorId}`);
    const r = await api.rescale(actor, level, { copy });
    return { actorId: r.actor.id, name: r.actor.name, from: r.from, to: r.to, changes: r.changes };
  },

  "forge-create": async ({ spec }) => {
    const api = forgeApi();
    const { actor, stats, warnings, missing } = await api.create(withRole(api, spec), { openSheet: true });
    return {
      actorId: actor.id, name: actor.name, level: stats.level,
      hp: stats.hp, ac: stats.ac,
      warnings: warnings.length ? warnings : undefined,
      missing: missing.length ? missing : undefined,
    };
  },
};
