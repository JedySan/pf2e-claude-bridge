# PF2e Claude Bridge

Свой коннектор Claude ↔ Foundry VTT для системы **Pathfinder 2e**. Claude (через Claude Desktop и MCP)
читает мир, строит энкаунтеры и ведёт монстров в бою — без сторонних подписок.

```
Claude Desktop ──stdio/MCP──▶ server/ (ваш компьютер) ──ws://127.0.0.1:47811──▶ модуль (вкладка ГМа) ──▶ мир Foundry
```

Репозиторий состоит из двух частей:

| Папка | Что это | Где работает |
|---|---|---|
| `module/` | Модуль Foundry | Ставится в Foundry, работает во вкладке ГМа |
| `server/` | MCP-сервер на Node.js | На компьютере, где запущен Claude Desktop |

## Установка

### 1. Модуль в Foundry

**Setup → Add-on Modules → Install Module**, в поле **Manifest URL** вставить:

```
https://github.com/JedySan/pf2e-claude-bridge/releases/latest/download/module.json
```

Включить **PF2e Claude Bridge** в мире. Обновления Foundry будет подтягивать сам.

### 2. MCP-сервер на компьютере

Нужен Node.js 20+.

```bash
git clone https://github.com/JedySan/pf2e-claude-bridge.git ~/pf2e-claude-bridge
cd ~/pf2e-claude-bridge/server && npm install
openssl rand -hex 16   # сгенерировать секрет
```

### 3. Конфиг Claude Desktop

Settings → Developer → **Edit Config**, в `mcpServers` добавить:

```json
"pf2e-bridge": {
  "command": "/opt/homebrew/bin/node",
  "args": ["/Users/<you>/pf2e-claude-bridge/server/index.js"],
  "env": {
    "PF2E_BRIDGE_SECRET": "<секрет>",
    "PF2E_BRIDGE_ORIGINS": "https://<адрес-вашего-foundry>"
  }
}
```

- `command` — полный путь к node (`which node`): Claude Desktop запускается с урезанным PATH.
- `PF2E_BRIDGE_ORIGINS` — адреса, с которых разрешено подключение (через запятую). Пусто — любые.
- `PF2E_BRIDGE_PORT` — порт, если 47811 занят (тогда поменять и в настройках модуля).

Полностью перезапустить Claude Desktop (Cmd+Q).

### 4. Связать модуль с сервером

В Foundry: **Configure Settings → Module Settings → PF2e Claude Bridge** → вставить тот же секрет.
Появится уведомление «Claude Bridge: подключено».

> Открывайте мир в **Chrome / Edge / Firefox**. Safari не пускает страницу с сервера к `127.0.0.1`.
> Chrome один раз спросит доступ к локальной сети — разрешить.

## Инструменты

| Инструмент | Что делает |
|---|---|
| `world-info` | Мир, система, активная сцена, кто онлайн, идёт ли бой |
| `get-scene` | Компактная сцена: токены в клетках, сторона, уровень, HP, КБ, состояния pf2e |

## Отладка

- Консоль браузера: `game.modules.get("pf2e-claude-bridge").api.status()`
- Логи сервера: Claude Desktop → Settings → Developer → pf2e-bridge → View logs

## Выпуск новой версии

Поднять `version` в `module/module.json` и `server/package.json`, затем:

```bash
gh release create v0.2.0 --generate-notes
```

GitHub Actions соберёт `module.zip`, проставит версию и ссылку на архив в `module.json`
и приложит оба файла к релизу.
