// Кнопка «Карта из картинки» во вкладке сцен (только ГМ): выбрать картинку (можно сразу загрузить),
// указать ширину в клетках — создаётся сцена с подогнанной сеткой. Разметку делает Claude.
import { mapHandlers } from "./handlers/maps.js";

async function openImportDialog() {
  const { DialogV2 } = foundry.applications.api;
  const FP = foundry.applications.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  const result = await DialogV2.prompt({
    window: { title: "Карта из картинки", icon: "fa-solid fa-map" },
    content: `
      <p>Картинка батлмапы (экспорт из Inkarnate, Dungeondraft и т. п.) без сетки.
      Сетку Foundry подгонит по ширине карты в клетках.</p>
      <div class="form-group"><label>Картинка</label>
        <div class="form-fields"><input type="text" name="src" placeholder="worlds/…/maps/map.webp">
        <button type="button" class="pcb-pick" title="Выбрать или загрузить"><i class="fa-solid fa-file-image"></i></button></div></div>
      <div class="form-group"><label>Ширина, клеток</label><input type="number" name="cols" placeholder="не знаю — подберёт Claude" min="5" max="200"></div>
      <div class="form-group"><label>Название сцены</label><input type="text" name="name" placeholder="по имени файла"></div>
      <div class="form-group"><label>Сразу активировать</label><input type="checkbox" name="activate"></div>`,
    render: (event, dialog) => {
      const el = dialog.element ?? event?.target?.element;
      el?.querySelector(".pcb-pick")?.addEventListener("click", () => {
        const input = el.querySelector('input[name="src"]');
        new FP({ type: "image", current: input.value, callback: (path) => { input.value = path; } }).render(true);
      });
    },
    ok: {
      label: "Создать сцену", icon: "fa-solid fa-map",
      callback: (e, b) => ({
        src: b.form.elements.src.value.trim(),
        cols: Number.isFinite(b.form.elements.cols.valueAsNumber) ? b.form.elements.cols.valueAsNumber : undefined,
        name: b.form.elements.name.value.trim(),
        activate: b.form.elements.activate.checked,
      }),
    },
    rejectClose: false,
  });
  if (!result?.src) return;
  try {
    const r = await mapHandlers["map-create-scene"](result);
    ui.notifications.info(`Сцена «${r.name}» создана: ${r.cells} клеток по ${r.grid}${r.guessed ? " (подобрано наугад — Claude уточнит)" : ""}. Скажите Claude: «разметь карту ${r.name}».`);
  } catch (e) {
    ui.notifications.error(`Карта из картинки: ${e.message}`);
  }
}

export function registerMapsUI() {
  Hooks.on("renderSceneDirectory", (app, html) => {
    if (!game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.querySelector(".pcb-map-import")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pcb-map-import";
    btn.innerHTML = '<i class="fa-solid fa-map"></i> Карта из картинки';
    btn.addEventListener("click", openImportDialog);
    (root.querySelector(".header-actions") ?? root.querySelector(".directory-header") ?? root).append(btn);
  });
}
