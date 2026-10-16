// Мир, сцены и токены.
import {
  requireScene, sceneGeometry, cellToXY, xyToCell, DISPOSITION_OUT, parseDisposition,
  conditionsOf, hpOf, findActor,
} from "../util.js";

function summarizeToken(t, scene) {
  const a = t.actor;
  const { col, row } = xyToCell(scene, t.x, t.y);
  const out = {
    id: t.id,
    name: t.name,
    col, row,
    size: t.width > 1 || t.height > 1 ? `${t.width}x${t.height}` : undefined,
    side: DISPOSITION_OUT[t.disposition] ?? t.disposition,
    hidden: t.hidden || undefined,
    actorId: a?.id,
    type: a?.type,
    level: a?.level,
    hp: hpOf(a),
    ac: a?.system?.attributes?.ac?.value,
  };
  const conds = conditionsOf(a);
  if (conds.length) out.conditions = conds;
  if (a && a.name !== t.name) out.actorName = a.name;
  return out;
}

export const sceneHandlers = {
  "world-info": async () => {
    const combat = game.combat;
    return {
      world: game.world.title,
      system: `${game.system.id} ${game.system.version}`,
      foundry: game.version,
      activeScene: game.scenes.active ? { id: game.scenes.active.id, name: game.scenes.active.name } : null,
      usersOnline: game.users.filter((u) => u.active).map((u) => `${u.name}${u.isGM ? " (ГМ)" : ""}`),
      combat: combat
        ? { scene: combat.scene?.name, round: combat.round, started: combat.started, turn: combat.combatant?.name ?? null }
        : null,
    };
  },

  "list-scenes": async ({ query }) => {
    const q = query?.toLowerCase();
    return game.scenes
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .map((s) => ({ id: s.id, name: s.name, active: s.active || undefined, tokens: s.tokens.size }));
  },

  "get-scene": async ({ scene }) => {
    const s = requireScene(scene);
    const g = sceneGeometry(s);
    const d = s.dimensions;
    return {
      id: s.id,
      name: s.name,
      active: s.active,
      sizeInCells: { cols: Math.round(d.sceneWidth / g.grid), rows: Math.round(d.sceneHeight / g.grid) },
      feetPerCell: s.grid.distance,
      darkness: s.environment?.darknessLevel ?? s.darkness ?? 0,
      tokens: s.tokens.map((t) => summarizeToken(t, s)),
    };
  },

  "place-tokens": async ({ scene, tokens }) => {
    const s = requireScene(scene);
    const docs = [];
    for (const spec of tokens) {
      const actor = findActor(spec.actorId);
      if (!actor) throw new Error(`Актёр не найден: ${spec.actorId}`);
      const { x, y } = cellToXY(s, spec.col, spec.row);
      const data = { x, y, hidden: !!spec.hidden };
      if (spec.name) data.name = spec.name;
      const disp = parseDisposition(spec.side);
      if (disp !== undefined) data.disposition = disp;
      const td = await actor.getTokenDocument(data);
      docs.push(td.toObject());
    }
    const created = await s.createEmbeddedDocuments("Token", docs);
    return { scene: s.name, created: created.map((t) => summarizeToken(t, s)) };
  },

  "update-tokens": async ({ scene, tokens }) => {
    const s = requireScene(scene);
    const updates = tokens.map((spec) => {
      const t = s.tokens.get(spec.id);
      if (!t) throw new Error(`Токен не найден на сцене «${s.name}»: ${spec.id}`);
      const u = { _id: t.id };
      if (spec.col !== undefined || spec.row !== undefined) {
        const cur = xyToCell(s, t.x, t.y);
        Object.assign(u, cellToXY(s, spec.col ?? cur.col, spec.row ?? cur.row));
      }
      if (spec.hidden !== undefined) u.hidden = spec.hidden;
      if (spec.name !== undefined) u.name = spec.name;
      const disp = parseDisposition(spec.side);
      if (disp !== undefined) u.disposition = disp;
      return u;
    });
    const updated = await s.updateEmbeddedDocuments("Token", updates);
    return { scene: s.name, updated: updated.map((t) => summarizeToken(t, s)) };
  },

  "delete-tokens": async ({ scene, ids }) => {
    const s = requireScene(scene);
    const existing = ids.filter((id) => s.tokens.has(id));
    const missing = ids.filter((id) => !s.tokens.has(id));
    const deleted = existing.length ? await s.deleteEmbeddedDocuments("Token", existing) : [];
    return { scene: s.name, deleted: deleted.map((t) => t.name), missing: missing.length ? missing : undefined };
  },

  "create-combat": async ({ scene, tokenIds, includeHidden = false, rollNpcInitiative = false }) => {
    const s = requireScene(scene);
    let tokens = tokenIds?.length
      ? tokenIds.map((id) => s.tokens.get(id)).filter(Boolean)
      : s.tokens.filter((t) => (includeHidden || !t.hidden) && (t.actor?.system?.attributes?.hp?.value ?? 1) > 0);
    tokens = tokens.filter((t) => t.actor);
    if (!tokens.length) throw new Error("Нет подходящих токенов для боя");

    const combat = await Combat.implementation.create({ scene: s.id });
    await combat.createEmbeddedDocuments("Combatant", tokens.map((t) => ({
      tokenId: t.id, sceneId: s.id, actorId: t.actor.id, hidden: t.hidden,
    })));
    await combat.activate();
    if (rollNpcInitiative) await combat.rollNPC();
    return {
      combatId: combat.id,
      scene: s.name,
      combatants: combat.combatants.map((c) => ({ name: c.name, initiative: c.initiative ?? undefined, hidden: c.hidden || undefined })),
    };
  },
};
