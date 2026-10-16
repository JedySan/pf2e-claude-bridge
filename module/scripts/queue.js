// Очередь для Claude: события, где нужно решение (исход спасброска против заклинания,
// вопрос «@claude» в чате, исход действия без однозначного эффекта).
// Живёт в памяти вкладки ГМа; Claude забирает её инструментом get-queue.

const MAX = 100;
const items = [];
let seq = 0;

export function enqueue(kind, data) {
  items.push({ n: ++seq, at: new Date().toLocaleTimeString("ru-RU"), kind, ...data });
  if (items.length > MAX) items.splice(0, items.length - MAX);
  ui.notifications?.info(`Claude: в очереди ${items.length}`, { console: false });
}

export function takeQueue({ peek = false } = {}) {
  const out = items.slice();
  if (!peek) items.length = 0;
  return out;
}

export function queueSize() {
  return items.length;
}
