# Incident Pulse — production runbook

Документ описывает минимальный набор действий, без которых выпуск дашборда в
production небезопасен. Он дополняет README и фиксирует решения по итогам
production-review (см. `docs/production-review.md`).

## 1. Модель развёртывания

- Один экземпляр `app` + один экземпляр `itsm-mock` в Docker Compose.
- `app` хранит SQLite в named volume `app-data`, mock — `mock-data`.
- `itsm-mock` — демонстрационный/интеграционный адаптер, не production ITSM.
  Порт mock по умолчанию публикуется только на `127.0.0.1`.
- TLS терминируется reverse proxy (nginx/Caddy/Traefik) перед `app:3000`.
- AI-функции опциональны: без AI-бэкенда дашборд работает, сводки/подсказки
  уходят в детерминированный fallback.

## 2. Обязательные переменные окружения

Скопируйте `.env.example` в `.env` и задайте:

```dotenv
# production
APP_BIND=127.0.0.1          # наружу смотрит только reverse proxy
APP_HOST_PORT=8080
MOCK_BIND=127.0.0.1         # mock не публикуется наружу
MOCK_HOST_PORT=8081

PUBLIC_ORIGIN=https://pulse.example.com
COOKIE_SECURE=true

DEMO_GENERATION=false       # никаких синтетических инцидентов в production
REGISTRATION_ENABLED=false  # новых пользователей создаёт администратор
# REGISTRATION_TOKEN=       # опционально, если нужен закрытый пилот

AI_BASE_URL=                 # пусто => AI выключен/fallback
# AI_BASE_URL=https://.../v1
# AI_MODEL=...
# AI_API_KEY=...
```

Не коммитьте `.env`. `start.sh` создаёт его с правами `600`; проверьте это
вручную после копирования.

## 3. Bootstrap администратора

На пустой базе сначала создайте администратора, затем выключите регистрацию:

```bash
# при запущенном app; скрипт работает с тем же volume /data
ADMIN_PASSWORD='сильный-пароль-не-короче-8' \
  docker compose exec -T -e ADMIN_PASSWORD app \
  node scripts/create-admin.js --login admin --name "Администратор"
```

Скрипт идемпотентен: если логин уже есть, он подтверждает роль `admin`.
Пароль должен быть не короче 8 символов; для production используйте
менеджер секретов и 12+ символов.

Проверка:

```bash
curl -fsS -X POST http://127.0.0.1:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"login":"admin","password":"..."}' -c /tmp/pulse.cookie
curl -fsS -b /tmp/pulse.cookie http://127.0.0.1:8080/api/v1/auth/me
```

## 4. TLS reverse proxy (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name pulse.example.com;

  ssl_certificate     /etc/letsencrypt/live/pulse.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/pulse.example.com/privkey.pem;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # SSE
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
  }
}

server {
  listen 80;
  server_name pulse.example.com;
  return 301 https://$host$request_uri;
}
```

`PUBLIC_ORIGIN` должен совпадать с внешним origin (`https://pulse.example.com`),
иначе mutating-запросы получат `403`.

## 5. Сборка и выпуск

`start.sh` по умолчанию пересобирает образы (`docker compose up -d --build`).
Для быстрого рестарта без сборки есть `--no-build`.

```bash
# 1. тесты
(cd services/app && node --test)
(cd services/itsm-mock && node --test)

# 2. проверка compose
docker compose config --quiet

# 3. сборка и запуск
./start.sh --mode=api --no-build   # если образ уже собран
# или
./start.sh                          # с пересборкой

# 4. проверка
curl -fsS http://127.0.0.1:8080/api/v1/ready
docker compose ps
```

Перед выпуском зафиксируйте git commit и тег; образы стоит публиковать с
неизменяемым тегом/дайджестом. `/api/v1/health` и `/api/v1/ready` возвращают
версию приложения.

## 6. Backup и restore

### SQLite (app)

WAL-режим нельзя копировать «на живую» одним файлом. Используйте
`VACUUM INTO` внутри контейнера:

```bash
docker compose exec -T app node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/data/incident-pulse.sqlite');
  db.exec(\"VACUUM INTO '/data/backup-$(date +%s).sqlite'\");
  db.close();
"
docker compose cp app:/data/backup-<ts>.sqlite ./backups/
```

Приложение само делает backup перед destructive-сценариями:
`revision_ahead` от mock и `demo/reset`. Файлы лежат в `/data`
(`incident-pulse.backup-*.sqlite`, хранятся последние 5).

### mock

```bash
docker compose cp itsm-mock:/data/state.json ./backups/state-$(date +%s).json
```

### Restore

```bash
docker compose stop app
docker compose cp ./backups/incident-pulse.sqlite app:/data/incident-pulse.sqlite
docker compose cp ./backups/state.json itsm-mock:/data/state.json
docker compose start itsm-mock app
curl -fsS http://127.0.0.1:8080/api/v1/ready
```

Restore проверяйте на отдельном стенде: после отката возможны `revision_ahead`,
и app перечитает mock с нуля (с автоматическим backup).

## 7. Обновление и откат

```bash
git fetch --tags
git checkout <tag>
# backup (см. выше)
./start.sh --no-build   # если образ уже собран из этого тега
# иначе ./start.sh (пересоберёт)
curl -fsS http://127.0.0.1:8080/api/v1/ready
```

Если миграция несовместима — остановите app, восстановите backup и верните
предыдущий образ/тег. Миграции в коде аддитивные (`ALTER TABLE ... ADD COLUMN`),
но перед обновлением backup обязателен.

## 8. Мониторинг и эксплуатация

- `GET /api/v1/health` — liveness (процесс жив).
- `GET /api/v1/ready` — readiness: SQLite открыт, отдаёт `sync`, версию.
- `GET /api/v1/admin/system` — revision, `syncError`, mockReachable, счётчики.
- `GET /api/v1/admin/sync-failures?limit=50` — dead-letter записи ITSM,
  которые не прошли валидацию (не блокируют остальную синхронизацию).
- `GET /api/v1/admin/audit` — административные действия.
- SSE-счётчики и AI-ошибки пока не экспортируются в Prometheus; смотрите
  логи контейнера и `docker compose ps`.
- Логи: `docker compose logs -f app itsm-mock`; в compose включена ротация
  json-file (10 MiB × 3).

Рекомендуемые алерты: `ready` != 200, `syncError` != null дольше 5 минут,
рост `sync_failures`, рестарты контейнеров, заполнение volume > 80%.

## 9. Security-чек-лист

- [ ] `MOCK_BIND=127.0.0.1`, mock не доступен из интернета/LAN.
- [ ] TLS включён, `PUBLIC_ORIGIN` и `COOKIE_SECURE=true`.
- [ ] `REGISTRATION_ENABLED=false`, администратор создан скриптом.
- [ ] `DEMO_GENERATION=false`, синтетические инциденты не попадают в ленту.
- [ ] Пароли 12+ символов, менеджер секретов; `.env` с правами 600.
- [ ] AI-ключ хранится в secret store; `AI_BASE_URL` только HTTPS; решён
      вопрос передачи описаний инцидентов внешнему провайдеру.
- [ ] Backup/restore проверены на копии, retention и место на диске
      контролируются.
- [ ] Reverse proxy ограничивает размер тела и таймауты; заголовки HSTS/CSP
      приходят от app.

## 10. Известные ограничения

- Один экземпляр app: SSE и очередь операций локальны процессу; горизонтальное
  масштабирование без внешней шины не поддерживается.
- Нет SSO/MFA, смены пароля и self-service сброса; управление пользователями —
  через админ-панель/скрипт.
- SSE не гарантирует replay: клиент перечитывает доску при реконнекте, но
  события между разрывами не воспроизводятся.
- Нет пагинации `/api/v1/incidents` и retention для history/audit; при сотнях
  тысяч записей нужны дополнительные работы.
- Триаж дублей — O(n²) по кейсам; для больших объёмов нужен worker/кеш.
- Публичная стена `/wall` по умолчанию доступна без входа; если она не нужна
  в интернете — закройте её на прокси или уберите маршрут.
