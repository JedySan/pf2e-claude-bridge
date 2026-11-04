// Статистика бросков d20 по персонажам: сколько бросков, среднее, сколько единиц и двадцаток.
// Копит активный ГМ (у него же автоматика), хранится в настройке мира — переживает перезагрузки.
// В чате: «@Гриша средние» — таблица всем, «@Гриша средние шёпотом» — только ГМу,
// «@Гриша сбрось статистику» — начать заново.
import { MODULE_ID } from "./util.js";

const KEY = "d20Stats";
const NPC_KEY = "__npc__";
let pending = null;
let saveTimer = null;

export function registerStatsSettings() {
  game.settings.register(MODULE_ID, KEY, { scope: "world", config: false, type: Object, default: { since: null, actors: {} } });
  game.settings.register(MODULE_ID, "trackD20", {
    name: "Статистика бросков d20",
    hint: "Запоминать броски d20 каждого персонажа. В чате: «@Гриша средние» — таблица средних, «@Гриша сбрось статистику» — заново.",
    scope: "world", config: true, type: Boolean, default: true,
  });
}

function load() {
  if (pending) return pending;
  const s = foundry.utils.deepClone(game.settings.get(MODULE_ID, KEY) ?? {});
  pending = { since: s.since ?? new Date().toISOString(), actors: s.actors ?? {} };
  return pending;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = pending;
    pending = null;
    game.settings.set(MODULE_ID, KEY, data).catch((e) => console.error(`[${MODULE_ID}] статистика`, e));
  }, 1500);
}

/** Все результаты d20 из бросков сообщения (включая оба куба при броске с преимуществом). */
export function d20Results(rolls) {
  const out = [];
  const walk = (terms) => {
    for (const t of terms ?? []) {
      if (t?.faces === 20 && Array.isArray(t.results)) out.push(...t.results.filter((r) => r.result >= 1 && r.result <= 20).map((r) => r.result));
      if (t?.rolls) for (const r of t.rolls) walk(r.terms);   // группы (PoolTerm)
      if (t?.terms) walk(t.terms);                            // скобки (ParentheticalTerm)
      if (t?.roll?.terms) walk(t.roll.terms);
    }
  };
  for (const roll of rolls ?? []) walk(roll.terms);
  return out;
}

/** Учесть броски из сообщения. Вызывается автоматикой у активного ГМа. */
export function recordRolls(msg) {
  if (!game.settings.get(MODULE_ID, "trackD20") || !msg.rolls?.length) return;
  const results = d20Results(msg.rolls);
  if (!results.length) return;
  const actor = msg.actor ?? game.actors.get(msg.speaker?.actor);
  const pc = actor && (actor.type === "character" || actor.hasPlayerOwner);
  const key = pc ? actor.id : NPC_KEY;
  const name = pc ? actor.name : "Мастер (NPC)";
  const s = load();
  const a = (s.actors[key] ??= { name, n: 0, sum: 0, nat1: 0, nat20: 0 });
  a.name = name;
  for (const r of results) {
    a.n += 1; a.sum += r;
    if (r === 1) a.nat1 += 1;
    if (r === 20) a.nat20 += 1;
  }
  scheduleSave();
}

export function statsTable() {
  const s = load();
  const rows = Object.entries(s.actors)
    .map(([k, a]) => ({ key: k, name: a.name, n: a.n, avg: a.n ? a.sum / a.n : 0, nat1: a.nat1, nat20: a.nat20 }))
    .filter((r) => r.n)
    .sort((x, y) => (x.key === NPC_KEY) - (y.key === NPC_KEY) || y.avg - x.avg);
  return { since: s.since, rows };
}

export async function resetStats() {
  clearTimeout(saveTimer);
  pending = null;
  await game.settings.set(MODULE_ID, KEY, { since: new Date().toISOString(), actors: {} });
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }); } catch { return iso; }
}

/** Таблица средних в чат. to: "all" — всем, "gm" — шёпотом ГМу. */
export async function postStats({ to = "all" } = {}) {
  const { since, rows } = statsTable();
  const name = game.settings.get(MODULE_ID, "assistantName") || "Гриша";
  const body = rows.length
    ? `<table style="width:100%;font-size:12px"><tr><th style="text-align:left">Персонаж</th><th>Бросков</th><th>Среднее</th><th>1</th><th>20</th></tr>` +
      rows.map((r) => `<tr><td>${foundry.utils.escapeHTML(r.name)}</td><td style="text-align:center">${r.n}</td>` +
        `<td style="text-align:center"><b>${r.avg.toFixed(2)}</b></td><td style="text-align:center">${r.nat1}</td><td style="text-align:center">${r.nat20}</td></tr>`).join("") +
      `</table><p style="font-size:11px;opacity:.7">Броски d20 с ${fmtDate(since)}. Ожидаемое среднее — 10,5.</p>`
    : `<p>Пока нет ни одного броска d20 (считаю с ${fmtDate(since)}).</p>`;
  await ChatMessage.create({
    content: `<h3>🎲 Средние броски d20</h3>${body}`,
    speaker: { alias: name },
    whisper: to === "gm" ? ChatMessage.getWhisperRecipients("GM").map((u) => u.id) : [],
    flags: { [MODULE_ID]: { assistant: true } },
  });
  return { since, rows: rows.map((r) => ({ ...r, avg: Number(r.avg.toFixed(2)) })) };
}

/** Команда статистики в тексте обращения к ассистенту. Возвращает true, если обработано. */
export async function handleStatsCommand(text, { fromGM }) {
  const t = text.toLowerCase();
  if (/сбро[сш]|обнул|reset/.test(t) && /стат|средн|брос|куб/.test(t)) {
    if (!fromGM) return false;
    await resetStats();
    await ChatMessage.create({ content: "<p>🎲 Статистика бросков d20 обнулена — считаю заново.</p>",
      speaker: { alias: game.settings.get(MODULE_ID, "assistantName") || "Гриша" }, flags: { [MODULE_ID]: { assistant: true } } });
    return true;
  }
  if (/средн|статистик|stats/.test(t)) {
    await postStats({ to: /шёпот|шепот|мне|whisper/.test(t) ? "gm" : "all" });
    return true;
  }
  return false;
}
