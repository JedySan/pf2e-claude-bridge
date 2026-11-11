// Очередь для Claude: события, где нужно решение (исход спасброска против заклинания,
// вопрос «@claude» в чате, исход действия без однозначного эффекта).
// Живёт во вкладке ГМа и сохраняется в её браузере (localStorage), поэтому переживает F5.
// Claude забирает её инструментом get-queue.
// Размер очереди показывается на плашке ассистента (indicator.js).

const MODULE_ID = "pf2e-claude-bridge";
const MAX = 100;
let items = null;
let seq = 0;

const storageKey = () => `${MODULE_ID}.queue.${globalThis.game?.world?.id ?? "world"}`;

function load() {
  if (items) return items;
  items = [];
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(storageKey()) ?? "null");
    if (Array.isArray(saved?.items)) {
      items = saved.items.slice(-MAX);
      seq = Number(saved.seq) || items.at(-1)?.n || 0;
    }
  } catch { /* хранилище недоступно или повреждено — начинаем с пустой */ }
  return items;
}

function save() {
  try { globalThis.localStorage?.setItem(storageKey(), JSON.stringify({ seq, items })); } catch { /* переполнено — живём в памяти */ }
}

const notify = () => Hooks.callAll(`${MODULE_ID}.queue`, items.length);

export function enqueue(kind, data) {
  load();
  items.push({ n: ++seq, at: new Date().toLocaleTimeString("ru-RU"), kind, ...data });
  if (items.length > MAX) items.splice(0, items.length - MAX);
  save();
  notify();
}

export function takeQueue({ peek = false } = {}) {
  load();
  const out = items.slice();
  if (!peek) {
    items.length = 0;
    save();
    notify();
  }
  return out;
}

export function queueSize() {
  return load().length;
}

/** Показать на плашке очередь, оставшуюся с прошлой загрузки страницы. */
export function restoreQueue() {
  load();
  if (items.length) notify();
}
