# Платформа внедрения ИИ инструментов (Фонд МИК)

Веб-платформа для учёта и аналитики использования ИИ-инструментов: кейсы, промпты, каталог инструментов, дашборд и админ-панель.

## Стек

- **Backend:** Node.js 18+, Express
- **БД:** SQLite (better-sqlite3)
- **Фронт:** статический HTML/CSS/JS (без сборки)

## Запуск локально

```bash
cd AI
npm install
npm start
```

Откройте: http://localhost:19080 (или задайте `PORT` в `.env`)

- **/** — главная (платформа, кейсы, решения)
- **/dashboard** — аналитический дашборд
- **/admin** — админ-панель (сущности)
- **/profile** — личный профиль
- **/audio-assistant** — расшифровка аудио/видео и суммаризация текста
- **/admin → Audio Text Assistant** — admin-only настройка i.moscow и режимов сервиса

При первом запуске БД создаётся автоматически и заполняется дефолтными подразделениями, кейсами, промптами, инструментами и задачами.

## Запуск в Docker

```bash
docker compose up -d
```

Сайт: **http://localhost:19080**. Используется нестандартный порт 19080 для инфраструктуры с ограниченным числом портов. Чтобы изменить порт на хосте, в `docker-compose.yml` задайте маппинг `"<хост>:19080"` (внутри контейнера приложение всегда слушает значение `PORT`). Данные SQLite хранятся в volume `platform_data`.

## API

- `GET/PUT /api/departments` — подразделения
- `GET/POST/PUT/DELETE /api/cases` — кейсы
- `GET/POST/PUT/DELETE /api/prompts` — промпты
- `GET/POST/PUT/DELETE /api/tools` — инструменты
- `GET/POST/PUT/DELETE /api/tasks` — задачи (для дашборда)
- `GET /api/analytics/dataset` — данные для дашборда
- `POST /api/analytics/events` — запись событий
- `POST /api/analytics/kv` — ключ-значение для дашборда
- `GET /api/health` — проверка работы
- `GET/POST /api/transcriptions` — история и создание расшифровок
- `GET /api/transcriptions/:id` — статус и результат расшифровки
- `POST /api/summarizer/summaries` — суммаризация произвольного текста
- `GET/PUT /api/admin/audio-assistant-settings` — защищённые настройки Audio Text Assistant (только admin)
- `GET /api/admin/audio-assistant-logs` — очищенный журнал внешних запросов (только admin)

## Деплой на сервер

1. Клонировать репозиторий, перейти в каталог проекта.
2. Задать переменные (опционально): `PORT` (по умолчанию 19080), `DATABASE_PATH` (см. `.env.example`).
3. Запуск через Docker:
   ```bash
   docker compose up -d
   ```
   Или без Docker:
   ```bash
   npm ci --omit=dev
   npm start
   ```
4. Проксировать через nginx/caddy на порт **19080** при необходимости (или на свой `PORT`).

Данные хранятся в `data/platform.db` (или в volume в Docker). Регулярно делайте бэкап этого файла.
