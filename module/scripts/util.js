// Общие утилиты модуля.

export const MODULE_ID = "pf2e-claude-bridge";
export const ENCOUNTER_FOLDER = "Claude — энкаунтеры";

const getProp = (obj, path) => foundry.utils.getProperty(obj, path);
export { getProp };

export function findScene(ref) {
  if (!ref) return game.scenes.active ?? canvas.scene;
  return game.scenes.get(ref) ?? game.scenes.getName(ref)
    ?? game.scenes.find((s) => s.name.toLowerCase().includes(ref.toLowerCase()));
}

export function requireScene(ref) {
  const s = findScene(ref);
  if (!s) throw new Error(`Сцена не найдена: ${ref ?? "(активной нет)"}`);
  return s;
}

/** Геометрия сцены: размер клетки и левый верхний угол игровой области. */
export function sceneGeometry(scene) {
  const d = scene.dimensions;
  return { grid: scene.grid.size, originX: d.sceneX, originY: d.sceneY };
}

export function cellToXY(scene, col, row) {
  const g = sceneGeometry(scene);
  return { x: g.originX + col * g.grid, y: g.originY + row * g.grid };
}

export function xyToCell(scene, x, y) {
  const g = sceneGeometry(scene);
  return { col: Math.round((x - g.originX) / g.grid), row: Math.round((y - g.originY) / g.grid) };
}

export const DISPOSITION_OUT = { [-2]: "секрет", [-1]: "враг", 0: "нейтрал", 1: "союзник" };

const DISPOSITION_IN = {
  враг: -1, hostile: -1, enemy: -1,
  нейтрал: 0, neutral: 0,
  союзник: 1, friendly: 1, ally: 1,
  секрет: -2, secret: -2,
};

export function parseDisposition(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return v;
  const d = DISPOSITION_IN[String(v).toLowerCase()];
  if (d === undefined) throw new Error(`Неизвестное отношение: ${v} (враг/нейтрал/союзник)`);
  return d;
}

/** Состояния pf2e. В pf2e имя уже содержит значение («Ранен 4»), не дублируем его. */
export function conditionsOf(actor) {
  try {
    return (actor?.conditions?.active ?? []).map((c) => c.name);
  } catch {
    return [];
  }
}

export function hpOf(actor) {
  const hp = actor?.system?.attributes?.hp;
  if (!hp) return undefined;
  return `${hp.value}/${hp.max}${hp.temp ? ` (+${hp.temp} врем.)` : ""}`;
}

export function stripHtml(html, max = 200) {
  if (!html) return "";
  const text = String(html)
    .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1")   // @UUID[...]{Текст} → Текст
    .replace(/@Damage\[([^\]]*)\]/g, "$1")
    .replace(/@\w+\[([^\]]*)\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return max && text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Найти актёра мира по ID или точному имени. */
export function findActor(ref) {
  if (!ref) return null;
  return game.actors.get(ref) ?? game.actors.getName(ref) ?? null;
}

export async function ensureEncounterFolder() {
  let folder = game.folders.find((f) => f.type === "Actor" && f.name === ENCOUNTER_FOLDER);
  if (!folder) folder = await Folder.create({ name: ENCOUNTER_FOLDER, type: "Actor", color: "#4a2d6b" });
  return folder;
}
