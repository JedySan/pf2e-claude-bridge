// Картограф: импорт готовых батлмап (Inkarnate и др.) — сцена по картинке, разметка стен,
// дверей, окон и света по описанию от Claude. Claude смотрит на карту через map-view
// (картинка с сеткой координат и уже поставленной разметкой) и присылает разметку в клетках.
//
// Координаты разметки — в клетках сцены от левого верхнего угла карты, дробные допустимы
// (12.5, 7 — середина клетки по X). Всё созданное помечается флагом модуля — map-clear убирает только своё.
import { MODULE_ID, requireScene } from "../util.js";

const FLAG = { [MODULE_ID]: { map: true } };

function geom(scene) {
  const d = scene.dimensions;
  return { x0: d.sceneX, y0: d.sceneY, size: d.size, w: d.sceneWidth, h: d.sceneHeight,
    cols: d.sceneWidth / d.size, rows: d.sceneHeight / d.size };
}

const toPx = (g, x, y) => [Math.round(g.x0 + x * g.size), Math.round(g.y0 + y * g.size)];
const toCell = (g, x, y) => [(x - g.x0) / g.size, (y - g.y0) / g.size];

async function loadImage(src) {
  if (!src) throw new Error("У сцены нет фоновой картинки");
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = foundry.utils.getRoute?.(src) ?? src;
  await img.decode();
  return img;
}

/** Отрезки из ломаных: [[x,y],[x,y],…] или плоский [x1,y1,x2,y2,…]. */
function segments(lines) {
  const out = [];
  for (const line of lines ?? []) {
    const pts = Array.isArray(line[0]) ? line : line.reduce((a, v, i) => (i % 2 ? a[a.length - 1].push(v) : a.push([v]), a), []);
    for (let i = 1; i < pts.length; i++) out.push([...pts[i - 1], ...pts[i]]);
  }
  return out;
}

function wallTypes() {
  const S = CONST.WALL_SENSE_TYPES, M = CONST.WALL_MOVEMENT_TYPES ?? CONST.WALL_SENSE_TYPES;
  return {
    wall: {},
    door: { door: CONST.WALL_DOOR_TYPES.DOOR },
    secret: { door: CONST.WALL_DOOR_TYPES.SECRET },
    // Окно: не пройти, но видно и светло насквозь.
    window: { move: M.NORMAL, sight: S.NONE, light: S.NONE, sound: S.NORMAL },
    // Низкая стена/ограда: не пройти без действия, но видно поверх.
    low: { move: M.NORMAL, sight: S.NONE, light: S.NONE, sound: S.NONE },
    // Невидимая граница (обрыв, вода): видно, но токены не проходят.
    invisible: { move: M.NORMAL, sight: S.NONE, light: S.NONE, sound: S.NONE },
  };
}

function drawGridAndOverlay(ctx, scene, g, region, k, { grid, overlay }) {
  const px = (cx) => (cx - region.x) * g.size * k;
  const py = (cy) => (cy - region.y) * g.size * k;
  if (grid) {
    ctx.lineWidth = 1;
    for (let c = Math.ceil(region.x); c <= region.x + region.w; c++) {
      const strong = c % 5 === 0;
      ctx.strokeStyle = strong ? "rgba(255,40,40,0.85)" : "rgba(255,255,0,0.45)";
      ctx.beginPath(); ctx.moveTo(px(c), 0); ctx.lineTo(px(c), region.h * g.size * k); ctx.stroke();
    }
    for (let r = Math.ceil(region.y); r <= region.y + region.h; r++) {
      const strong = r % 5 === 0;
      ctx.strokeStyle = strong ? "rgba(255,40,40,0.85)" : "rgba(255,255,0,0.45)";
      ctx.beginPath(); ctx.moveTo(0, py(r)); ctx.lineTo(region.w * g.size * k, py(r)); ctx.stroke();
    }
    ctx.font = "bold 12px sans-serif";
    for (let c = Math.ceil(region.x / 5) * 5; c <= region.x + region.w; c += 5) {
      for (let r = Math.ceil(region.y / 5) * 5; r <= region.y + region.h; r += 5) {
        const t = `${c},${r}`;
        ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(px(c) + 1, py(r) + 1, ctx.measureText(t).width + 4, 14);
        ctx.fillStyle = "#fff"; ctx.fillText(t, px(c) + 3, py(r) + 12);
      }
    }
  }
  if (overlay) {
    for (const w of scene.walls) {
      const [a, b] = [toCell(g, w.c[0], w.c[1]), toCell(g, w.c[2], w.c[3])];
      const isWindow = w.door === 0 && w.sight === CONST.WALL_SENSE_TYPES.NONE;
      ctx.strokeStyle = w.door ? "#2d8cff" : isWindow ? "#3ff" : "#ff2a2a";
      ctx.lineWidth = w.door ? 6 : 4;
      ctx.beginPath(); ctx.moveTo(px(a[0]), py(a[1])); ctx.lineTo(px(b[0]), py(b[1])); ctx.stroke();
    }
    for (const l of scene.lights) {
      const [cx, cy] = toCell(g, l.x, l.y);
      ctx.fillStyle = "rgba(255,220,0,0.9)"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px(cx), py(cy), 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
}

const IMG_RE = /\.(webp|png|jpe?g|avif|gif)$/i;

/** Обойти папки данных Foundry и найти картинки (по части имени). */
async function findImages(query, roots, depth = 3, limit = 40) {
  const FP = foundry.applications.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  const out = [];
  const q = (query ?? "").toLowerCase();
  const walk = async (dir, d) => {
    if (out.length >= limit) return;
    let res;
    try { res = await FP.browse("data", dir); } catch { return; }
    for (const f of res.files ?? []) {
      if (IMG_RE.test(f) && (!q || decodeURIComponent(f).toLowerCase().includes(q))) out.push(decodeURIComponent(f));
    }
    if (d > 0) for (const sub of res.dirs ?? []) await walk(sub, d - 1);
  };
  for (const r of roots) await walk(r, depth);
  return out.slice(0, limit);
}

export const mapHandlers = {
  "map-files": async ({ query, folder }) => {
    const roots = folder ? [folder] : [`worlds/${game.world.id}`, "maps", "assets", "uploads", ""];
    const files = await findImages(query, roots, folder ? 3 : 2);
    return { files, note: files.length ? "Путь из списка — в map-create-scene (src)." : "Картинок не нашлось — уточните папку (folder) или часть имени (query)." };
  },


  "map-create-scene": async ({ name, src, cols, gridFeet = 5, activate = false }) => {
    const img = await loadImage(src);
    const W = img.naturalWidth, H = img.naturalHeight;
    // Ширина неизвестна — ~100 px на клетку (так экспортирует большинство редакторов); Claude уточнит по карте.
    const guessed = !cols;
    if (guessed) cols = Math.max(5, Math.round(W / 100));
    const size = Math.round(W / cols);
    if (size < 50) throw new Error(`Слишком мелкая клетка: ${size} px (картинка ${W}×${H}, ${cols} клеток). Минимум в Foundry — 50 px.`);
    const scene = await Scene.implementation.create({
      name: name || src.split("/").pop().replace(/\.[^.]+$/, ""),
      background: { src },
      width: W, height: H, padding: 0,
      grid: { size, distance: gridFeet, units: "ft" },
      tokenVision: true,
      flags: FLAG,
    });
    if (activate) await scene.activate();
    return { sceneId: scene.id, name: scene.name, image: `${W}×${H}`, grid: `${size} px`, cells: `${(W / size).toFixed(1)}×${(H / size).toFixed(1)}`,
      guessed: guessed || undefined,
      note: guessed
        ? "Ширина в клетках подобрана наугад (~100 px на клетку). Проверьте map-view: дверь ≈ 1 клетка, кровать ≈ 1×2, коридор 1–2 клетки; при необходимости map-set-grid."
        : "Дальше: map-view, чтобы посмотреть карту с сеткой, и map-apply с разметкой." };
  },

  "map-set-grid": async ({ scene: ref, cols, cellPx }) => {
    const scene = requireScene(ref);
    const W = scene.width;
    const size = Math.round(cellPx ?? W / cols);
    if (!(size >= 50)) throw new Error(`Клетка ${size} px — меньше минимума Foundry (50 px)`);
    // Стены и свет хранятся в пикселях — при смене сетки остаются на своих местах на картинке.
    await scene.update({ "grid.size": size });
    return { scene: scene.name, grid: `${size} px`, cells: `${(W / size).toFixed(1)}×${(scene.height / size).toFixed(1)}` };
  },

  "map-view": async ({ scene: ref, region, maxPx = 1600, grid = true, overlay = true }) => {
    const scene = requireScene(ref);
    const g = geom(scene);
    const img = await loadImage(scene.background?.src);
    const r = { x: region?.x ?? 0, y: region?.y ?? 0, w: region?.w ?? g.cols, h: region?.h ?? g.rows };
    // Картинка растянута на игровую область сцены.
    const sx = img.naturalWidth / g.w, sy = img.naturalHeight / g.h;
    const srcRect = [r.x * g.size * sx, r.y * g.size * sy, r.w * g.size * sx, r.h * g.size * sy];
    const k = Math.min(1, maxPx / Math.max(r.w * g.size, r.h * g.size));
    const canvasEl = document.createElement("canvas");
    canvasEl.width = Math.round(r.w * g.size * k);
    canvasEl.height = Math.round(r.h * g.size * k);
    const ctx = canvasEl.getContext("2d");
    ctx.drawImage(img, ...srcRect, 0, 0, canvasEl.width, canvasEl.height);
    drawGridAndOverlay(ctx, scene, g, r, k, { grid, overlay });
    return {
      __image: canvasEl.toDataURL("image/jpeg", 0.85),
      scene: scene.name, cells: `${g.cols}×${g.rows}`, region: r,
      walls: scene.walls.size, lights: scene.lights.size,
      legend: "Подписи — координаты клеток (каждые 5). Красные линии сетки — кратные 5. Разметка: красное — стены, синее — двери, голубое — окна/низкие, жёлтое — свет.",
    };
  },

  "map-apply": async ({ scene: ref, walls = [], doors = [], secretDoors = [], windows = [], lowWalls = [], invisible = [], lights = [], replace = false }) => {
    const scene = requireScene(ref);
    const g = geom(scene);
    if (replace) await clearOwn(scene, ["walls", "lights"]);
    const T = wallTypes();
    const docs = [];
    const add = (lines, type) => {
      for (const [x1, y1, x2, y2] of segments(lines)) {
        if (x1 === x2 && y1 === y2) continue;
        docs.push({ c: [...toPx(g, x1, y1), ...toPx(g, x2, y2)], ...T[type], flags: FLAG });
      }
    };
    add(walls, "wall"); add(doors, "door"); add(secretDoors, "secret"); add(windows, "window"); add(lowWalls, "low"); add(invisible, "invisible");
    const created = docs.length ? await scene.createEmbeddedDocuments("Wall", docs) : [];
    const lightDocs = lights.map((l) => {
      const [x, y] = toPx(g, l.x, l.y);
      const kind = l.kind ?? "torch";
      const preset = {
        torch: { bright: 10, dim: 20, color: "#ff9a3c", alpha: 0.35, animation: { type: "torch", speed: 3, intensity: 3 } },
        fireplace: { bright: 15, dim: 30, color: "#ff7a1a", alpha: 0.45, animation: { type: "flame", speed: 3, intensity: 4 } },
        candle: { bright: 5, dim: 10, color: "#ffc070", alpha: 0.3, animation: { type: "torch", speed: 2, intensity: 2 } },
        magic: { bright: 10, dim: 20, color: "#6ad1ff", alpha: 0.4, animation: { type: "pulse", speed: 2, intensity: 3 } },
      }[kind] ?? {};
      return { x, y, config: { ...preset, ...(l.bright ? { bright: l.bright } : {}), ...(l.dim ? { dim: l.dim } : {}), ...(l.color ? { color: l.color } : {}) }, flags: FLAG };
    });
    const createdLights = lightDocs.length ? await scene.createEmbeddedDocuments("AmbientLight", lightDocs) : [];
    return { scene: scene.name, walls: created.length, lights: createdLights.length, totalWalls: scene.walls.size,
      note: "Проверьте: map-view покажет карту с разметкой поверх." };
  },

  "map-clear": async ({ scene: ref, what = ["walls", "lights"], all = false }) => {
    const scene = requireScene(ref);
    const removed = all ? await clearAll(scene, what) : await clearOwn(scene, what);
    return { scene: scene.name, removed };
  },
};

async function clearOwn(scene, what) {
  const removed = {};
  if (what.includes("walls")) {
    const ids = scene.walls.filter((w) => w.flags?.[MODULE_ID]?.map).map((w) => w.id);
    if (ids.length) await scene.deleteEmbeddedDocuments("Wall", ids);
    removed.walls = ids.length;
  }
  if (what.includes("lights")) {
    const ids = scene.lights.filter((l) => l.flags?.[MODULE_ID]?.map).map((l) => l.id);
    if (ids.length) await scene.deleteEmbeddedDocuments("AmbientLight", ids);
    removed.lights = ids.length;
  }
  return removed;
}

async function clearAll(scene, what) {
  const removed = {};
  if (what.includes("walls")) { removed.walls = scene.walls.size; await scene.deleteEmbeddedDocuments("Wall", scene.walls.map((w) => w.id)); }
  if (what.includes("lights")) { removed.lights = scene.lights.size; await scene.deleteEmbeddedDocuments("AmbientLight", scene.lights.map((l) => l.id)); }
  return removed;
}
