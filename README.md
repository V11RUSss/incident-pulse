# Incident Pulse

Общий дашборд координаторов массовых инцидентов. Система состоит из двух Node.js-контейнеров без gateway и внешней СУБД:

- `itsm-mock` начинает с пустого состояния, генерирует реалистичные сценарии МТС и хранит текущую ревизию;
- `app` получает изменения через API, объединяет связанные записи в canonical cases, хранит пользователей и историю в SQLite, выполняет действия через mock и рассылает обновления по SSE.

## Быстрый запуск (одна команда)

Нужен Docker с Docker Compose v2. `start.sh` сам создаст `.env` (если его нет),
поднимет app + mock и настроит AI-бэкенд.

```bash
# Локальный движок: auto выбирает GPU (NVIDIA/Intel) или CPU
./start.sh --mode=vllm

# Принудительно CPU (llama.cpp), если GPU-путь недоступен
./start.sh --mode=vllm --engine=cpu

# Любой OpenAI-совместимый API: vLLM, DeepSeek, OpenAI, llama.cpp, LM Studio...
./start.sh --mode=api \
  --base-url=https://api.deepseek.com \
  --model=deepseek-chat \
  --api-key=...

# auto: если в .env задан внешний AI_BASE_URL — api, иначе vllm
./start.sh
```

В режиме `vllm`:

| Железо | Движок | Модель |
|---|---|---|
| NVIDIA GPU | vLLM CUDA | Qwen2.5-7B-Instruct-AWQ |
| Intel Arc / XPU | vLLM XPU | Qwen2.5-7B-Instruct-GPTQ-Int4 |
| CPU | llama.cpp | Qwen2.5-7B-Instruct-Q4_K_M |

Модель скачивается в `./models/<name>`, кэш — в `./cache/huggingface`;
оба каталога лежат рядом с проектом и сохраняются между перезапусками.
Первый запуск скачивает модель (4–6 ГБ) и занимает несколько минут.
На CPU 7B Q4 работает заметно медленнее GPU; для слабых машин можно задать
`--model-id` с меньшей моделью.

Доступные адреса после запуска:

- интерфейс: <http://localhost:8080>;
- mock API: <http://localhost:8081>;
- healthcheck app: <http://localhost:8080/api/v1/health>;
- healthcheck mock: <http://localhost:8081/health>.

В интерфейсе координатора есть кнопка **«Спросить»** (или `Ctrl+K`): фраза
на естественном языке превращается в фильтр дашборда. Модель только разбирает
намерение, а сервер исполняет whitelisted-фильтр; подробнее — в разделе
[«Спросить дашборд»](#спросить-дашборд).

## Ручной запуск через Docker Compose

Нужны свободные порты `8080` и `8081`. Команды из корня репозитория:

```bash
cd /srv/ml/apps/incident-pulse
if [ ! -f .env ]; then cp .env.example .env; fi
docker compose up --build
```

Локальный движок удобнее запускать через `start.sh`: он сам выставляет конфиг
под NVIDIA/Intel/CPU и ждёт загрузку модели. Файл `.env` нужен только для локальных настроек и не попадает в Git или Docker build context. Недоступный AI-бэкенд не мешает работе основной системы: AI-сводка уходит в детерминированный fallback.

Для запуска в фоне:

```bash
docker compose up --build -d
docker compose ps
```

Интерфейс поддерживает светлую и тёмную тему с переключателем в шапке; выбор сохраняется в браузере. `app.js` и `theme.js` подключаются как внешние same-origin скрипты, inline-скриптов нет. Статические HTML-ответы получают `Content-Security-Policy` (`script-src 'self'`, без inline-скриптов), `X-Frame-Options: DENY` и `Referrer-Policy: no-referrer`. Пути с сегментами, начинающимися с точки (`/.env`, `/.git/config`), возвращают `404`, а realpath-проверка не выпускает за пределы `STATIC_DIR`.

Проверка ответов из другого терминала:

```bash
curl --fail-with-body --silent --show-error http://localhost:8080/api/v1/health
curl --fail-with-body --silent --show-error http://localhost:8081/health
docker compose ps
```

Журналы и остановка:

```bash
docker compose logs -f app itsm-mock
```

```bash
docker compose stop
```

`docker compose stop` сохраняет контейнеры и данные. Удалить контейнеры и сеть без удаления named volumes:

```bash
docker compose down
```

## Пустое начальное состояние и генерация

На новых named volumes mock начинает работу с ревизией `0` и пустым списком инцидентов. Дашборд не наполняется автоматически при старте.

После входа нажмите **«Синхронизировать с ITSM»**. В Compose включено `DEMO_GENERATION=true`, поэтому этот запрос:

1. вызывает `POST /itsm/demo/tick` на mock и создаёт следующий шаг сценария;
2. получает изменившиеся записи по ревизии;
3. обновляет canonical cases и отправляет SSE собственным клиентам.

Фоновый poll каждые `2000` мс только читает изменения и ничего не генерирует. Каждое следующее нажатие кнопки продвигает демонстрационный сценарий: появляются новые записи, растёт число затронутых пользователей, меняются статусы и команды. Повторное чтение одной ревизии не создаёт изменений.

## Регистрация и вход

Откройте <http://localhost:8080> и зарегистрируйте учётную запись. Предустановленного пользователя нет. Первый зарегистрированный пользователь получает роль `admin`, все последующие — `coordinator`. Администратор управляет пользователями и демонстрационными сценариями, координаторы работают с инцидентами. Если база создана до появления ролей, роль `admin` автоматически получает самый ранний по `created_at` пользователь, поэтому существующая установка не блокируется.

Те же операции через `curl` в bash:

```bash
COOKIE_JAR="$(mktemp)"

curl --fail-with-body --silent --show-error \
  --request POST \
  --cookie-jar "$COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data '{"name":"Дежурный координатор","login":"coordinator","password":"incident-pulse-demo-password"}' \
  http://localhost:8080/api/v1/auth/register

curl --fail-with-body --silent --show-error \
  --request POST \
  --cookie "$COOKIE_JAR" \
  --cookie-jar "$COOKIE_JAR" \
  --header 'Content-Type: application/json' \
  --data '{"login":"coordinator","password":"incident-pulse-demo-password"}' \
  http://localhost:8080/api/v1/auth/login

curl --fail-with-body --silent --show-error \
  --cookie "$COOKIE_JAR" \
  http://localhost:8080/api/v1/auth/me
```

При повторной регистрации того же `login` используйте другой логин или выполните только вход. Сессия хранится в SQLite; cookie имеет `HttpOnly` и `SameSite=Lax`. Для локального HTTP задано `COOKIE_SECURE=false`, а при HTTPS можно включить `COOKIE_SECURE=true`.

Вход защищён от перебора: после 10 неудачных попыток для пары IP + нормализованный `login` в течение 5 минут возвращается `429` с `{"error":"Слишком много попыток входа; повторите позже","code":"rate_limited"}`. Успешный вход сбрасывает счётчик; лимит применяется только к `POST /api/v1/auth/login`.

Получить dashboard JSON:

```bash
curl --fail-with-body --silent --show-error \
  --cookie "$COOKIE_JAR" \
  http://localhost:8080/api/v1/incidents
```

Выполнить тот же генерацию и синхронизацию, что и кнопка в UI:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --cookie "$COOKIE_JAR" \
  http://localhost:8080/api/v1/sync/itsm
```

## Объединение записей и приоритет

App формирует canonical case по следующим правилам:

- повторная запись с тем же `id` обновляет источник, а не создаёт дубликат;
- разные незакрытые записи с одинаковым `correlationKey` объединяются в один case;
- `sourceIds` показывает вклады источников, а `affectedUsers` и `reportCount` являются суммой их текущих значений;
- `activeAffectedUsers` — сумма `affectedUsers` только незакрытых источников (`stateId` 0, 2 или 20); по ней считается автоматический приоритет;
- повторная синхронизация не удваивает суммы;
- новая запись с тем же `correlationKey` после закрытия предыдущего case начинает отдельный случай;
- стабильный `caseId` используется для действий, а primary display id выбирается из активных источников.

Автоматический приоритет зависит от `activeAffectedUsers`: закрытые источники (`stateId` 7 и 10) не раздувают автоприоритет, хотя остаются в общем `affectedUsers` для отображения:

| Затронуто пользователей | Автоприоритет |
| ---: | --- |
| 1–49 | `low` |
| 50–499 | `medium` |
| 500–999 | `high` |
| 1000 и более | `critical` |

Ручной priority override сохраняется при последующих синхронизациях. Возврат к автоматическому приоритету выполняется отдельным действием; интерфейс показывает источник приоритета и предупреждает о расхождении ручного и автоматического значений. Критические и высокие группы включают только активные случаи с соответствующим effective priority и не дублируются в колонке координации.

## Синхронизация и Live

Одна кнопка **«Синхронизировать»** делает один `POST /api/v1/sync/itsm`
и показывает результат. Дублирующая иконка refresh из тулбара удалена.

Индикатор **Live** в верхней панели — переключатель:

- Live ON — подписка SSE `GET /api/v1/events`; app получает `sync`/`incidents`
  и обновляет доску без перезагрузки;
- Live OFF — `EventSource` закрыт, новые события не принимаются;
  ручная синхронизация продолжает работать;
- выбор хранится в `localStorage` (`incident-pulse-live`);
- ошибка SSE показывает «Нет связи», но не сбрасывает выбор.

В эмуляторе `DEMO_GENERATION=true`: app каждые 3–9 секунд запускает 1–3 шага mock-генератора (`DEMO_MIN_INTERVAL_MS`/`DEMO_MAX_INTERVAL_MS`, `DEMO_BATCH_MIN`/`DEMO_BATCH_MAX`), затем синхронизируется и рассылает SSE. Интервалы и размер пачки случайные, поэтому инциденты приходят неравномерно. Генератор **не назначает команды и не переводит кейсы в работу** — это делает только координатор. Критические инциденты создаются реже: не чаще одного continuation-шага из двенадцати; по умолчанию остаётся один стартовый критический пример.
SSE раздаёт изменения браузеру. Это near-real-time, а не webhook от SimpleOne;
для настоящего push нужен отдельный webhook, но для демо достаточно polling + SSE.

## Действия координатора и lifecycle

В диалоге случая доступны назначение ответственного, смена координатора, ручной приоритет и возврат к auto, изменение deadline, выбор команды МТС, допустимые статусные переходы и история. Операции выполняются для всех `sourceIds` canonical case через атомарный bulk update mock.

| Действие | App API |
| --- | --- |
| Взять случай | `POST /api/v1/incidents/:caseId/claim` с `expectedVersion` |
| Передать координатору | `POST /api/v1/incidents/:caseId/coordinator` с `coordinatorId`, `expectedVersion` |
| Задать ручной приоритет | `POST /api/v1/incidents/:caseId/priority` с `priorityId`, опционально `expectedVersion` |
| Вернуть автоприоритет | `DELETE /api/v1/incidents/:caseId/priority-override` |
| Изменить срок | `POST /api/v1/incidents/:caseId/deadline` с `deadline`, опционально `expectedVersion` |
| Назначить команду | `POST /api/v1/incidents/:caseId/team` с `team`, опционально `expectedVersion` |
| Изменить статус | `POST /api/v1/incidents/:caseId/status` с `stateId`, `solution`, опционально `expectedVersion` |
| Посмотреть историю | `GET /api/v1/incidents/:caseId/history` |

Claim и передача другому координатору требуют `expectedVersion`; priority, deadline, team и status принимают его опционально. Если `expectedVersion` передан и не совпадает с `incident.version`, API возвращает `409` и актуальное состояние (`incident`, `currentVersion`). Список доступных координаторов предоставляет `GET /api/v1/coordinators`, а допустимые статусы и переходы — `GET /api/v1/meta`.

Жизненный цикл:

- `stateId=0` и `stateId=2` — активная работа; у таких записей `solution=null` и `completionDate=null`;
- группы отображения взаимоисключающие: critical/high показываются только в своей приоритетной колонке и не дублируются в coordination; в coordination попадают только активные medium/low без `assignedGroupName`;
- критический или высокий случай без команды всё равно остаётся в своей приоритетной колонке — назначить команду можно из диалога;
- назначение команды переводит случай в `stateId=2`, убирает его из coordination, сохраняет приоритет и показывает в секции «В работе», но не переводит сразу в research; после успешного назначения команды диалог закрывается, чтобы карточка была видна на доске; смена приоритета также закрывает диалог, назначение координатора — нет;
- research соответствует `stateId=20` и заполненному решению; такие случаи не дублируются в active critical/high;
- `stateId=7` и `stateId=10` переводят случай в архив закрытых.

Сервер проверяет переходы: `0 → 2/20/7/10`, `2 → 20/7/10`, `20 → 7/10`, `7 → 10`, `10 →` без переходов. Недопустимый переход возвращает `409` с понятным сообщением; допустимые переходы клиент получает из `GET /api/v1/meta` (`transitions[String(stateId)]`).

История фиксирует автора, время и содержание действия. SSE обновляет открытые экраны без перезагрузки и сохраняет фильтры и контекст. Уведомления создаются только для реальных изменений; ошибки синхронизации отображаются как `syncError`, а не скрываются. Бейджи Master/Effect/source count с карточек удалены; источник остаётся в деталях кейса. Блок легенды внизу страницы удалён.

### Доска и «В работе»

Четыре основные колонки — критические, координация, высокий приоритет,
исследование. После назначения команды medium/low больше не исчезают: они
попадают в полноширинную секцию **«В работе»** под доской.

```text
Критические | На координаторов | Высокий приоритет | Исследование
────────────────────────────────────────────────────────────────
В работе · N
[карточка] [карточка] [карточка]
```

- «В работе» — вычисляемая display-группа, canonical `groups` не меняются:
  `active + team` без critical/high/coordination/research;
- карточка остаётся в поиске, не уходит в архив и не дублируется в других
  колонках;
- общий счётчик **«Активные»** не меняется, счётчик секции — это подмножество;
- при 0 карточек секция и чип скрыты;
- в data-strip есть чип **«В работе N»**, который прокручивает к секции;
- при длинной доске слева внизу появляется floating **«В работе N»**, когда секция вне вьюпорта;
- 3 карточки в ряд на десктопе, 2 на планшете, 1 на мобильном;
- отдельная вкладка/маршрут не нужны.

## Уведомления координатору

При передаче инцидента другому координатору (`POST /api/v1/incidents/:caseId/coordinator`)
создаётся targeted-уведомление:

- `notifications` в SQLite, unread/read-at, cascade при удалении пользователя;
- SSE event `notification` отправляется **только** сессиям получателя;
- колокольчик в topbar показывает unread, dropdown — список,
  «Прочитать все», клик открывает кейс и отмечает прочитанным;
- новое уведомление всплывает обычным non-critical toast и остаётся в колокольчике;
- критические баннеры/уведомления об инцидентах не затронуты.

API: `GET /api/v1/notifications`, `POST /api/v1/notifications/:id/read`,
`POST /api/v1/notifications/read-all`.

## Роли и админ-панель

Роль хранится в `users.role` (`admin` или `coordinator`). Все эндпоинты ниже требуют аутентификации и роли `admin`; координатор получает `403` с `{"error":"Требуются права администратора","code":"forbidden"}`. Ответы `/api/v1/auth/register`, `/api/v1/auth/login` и `/api/v1/auth/me` содержат `user.role`.

| Действие | Endpoint | Ответ |
| --- | --- | --- |
| Список пользователей | `GET /api/v1/admin/users` | `{users:[{id,name,login,role,createdAt,sessionCount,lastSessionAt}]}` по возрастанию `createdAt` |
| Удалить пользователя | `DELETE /api/v1/admin/users/:id` | `{ok:true,deletedUser:{id,name,login,role}}`; сессии удаляются каскадом |
| Сменить роль | `PATCH /api/v1/admin/users/:id/role` с `{"role":"admin"}` | `{user:{id,name,login,role}}` |
| Завершить сессии пользователя | `POST /api/v1/admin/users/:id/logout` | `{ok:true,removedSessions:N}` |
| Состояние системы | `GET /api/v1/admin/system` | `{revision,lastSyncedAt,syncError,counts,users,sessions,uptimeMs,mockReachable}` |
| Демо: следующий tick | `POST /api/v1/admin/demo/tick` | `{added,updated,revision,demo}` |
| Демо: критический инцидент | `POST /api/v1/admin/demo/critical` | `{added,updated,revision,demo}` |
| Демо: сброс mock | `POST /api/v1/admin/demo/reset` | `{ok:true,revision:0}` |
| Журнал действий | `GET /api/v1/admin/audit?limit=50` | `{audit:[{id,userId,userName,action,targetType,targetId,details,createdAt}]}` |

Правила: нельзя удалить собственную учётную запись; нельзя удалить или понизить последнего администратора (самопонижение разрешено, только если есть другой `admin`); несуществующий пользователь даёт `404`; неверная роль — `400`. Административные действия (`user.delete`, `user.role`, `user.logout`, `demo.tick`, `demo.critical`, `demo.reset`, а также ручная синхронизация `sync.manual`) пишутся в таблицу `audit`. `GET /api/v1/admin/system` проверяет mock с коротким таймаутом и не падает, если mock недоступен (`mockReachable:false`). Демо-эндпоинты синхронизируют состояние и при недоступном mock возвращают `502` с понятной ошибкой.

## Прямой доступ к mock API

Mock опубликован на `8081` без auth app и предназначен для локальной демонстрации. Не используйте его как публичный ITSM-сервис. Через app тот же mock проксируется по `/itsm/*` только после входа: без cookie запрос получает `401`, с cookie — ответ mock. Ссылка **«Открыть в ITSM»** открывает `/itsm/incidents/<id>/view` в новой вкладке, и same-origin cookie отправляется автоматически.

Получить все текущие записи или изменения после указанной ревизии:

```bash
curl --fail-with-body --silent --show-error \
  http://localhost:8081/itsm/incidents

curl --fail-with-body --silent --show-error \
  'http://localhost:8081/itsm/incidents?since=0'
```

Ответ содержит `revision`, `generatedAt` и `incidents`. Ревизия увеличивается только при фактическом изменении.

Сгенерировать следующий демонстрационный шаг непосредственно в mock:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  http://localhost:8081/itsm/demo/tick
```

Ответ содержит `revision`, `added`, `updated` и изменённые `incidents`. После прямого tick app получит изменения фоновым poll; отдельная генерация через кнопку для этого не нужна.

Создать гарантированный критический инцидент вне очереди и сбросить mock к пустому состоянию:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  http://localhost:8081/itsm/demo/critical

curl --fail-with-body --silent --show-error \
  --request POST \
  http://localhost:8081/itsm/demo/reset
```

`demo/critical` создаёт одну новую запись `MTS-CRIT-####` с `affectedUsers` 1200–3000, дедлайном через 10–15 минут, `stateId=0`, `isNeedUp=true`, уникальным `correlationKey`, версией 1 и увеличивает ревизию. `demo/reset` возвращает `{revision:0,incidents:[]}` и атомарно сохраняет пустое состояние.

Начиная с 13-го демонстрационного шага (после 12 стартовых сценариев) каждый третий tick гарантированно содержит критическое событие: чередуются создание нового критического инцидента (`affectedUsers` ≥ 1200, короткий дедлайн, `isNeedUp`) и эскалация существующего активного случая до `affectedUsers` ≥ 1000 с пояснением в описании. Остальные tick-и продолжают обычный сценарий; id новых критических записей детерминированно зависят от `demoStep` (`MTS-CRIT-####`), поэтому дубликатов нет.

Для примеров PATCH и bulk update скопируйте `id` из ответа mock:

```bash
read -r -p 'ID инцидента из ответа mock: ' MOCK_INCIDENT_ID

curl --fail-with-body --silent --show-error \
  --request PATCH \
  --header 'Content-Type: application/json' \
  --data '{"affectedUsers":1000}' \
  "http://localhost:8081/itsm/incidents/${MOCK_INCIDENT_ID}"
```

PATCH частично объединяет поля, обновляет версию записи и ревизию snapshot, возвращая `{updated,incident}`. После синхронизации `activeAffectedUsers` (сумма незакрытых источников) влияет на автоприоритет.

Атомарно применить один patch к нескольким источникам:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --data "{\"ids\":[\"${MOCK_INCIDENT_ID}\"],\"patch\":{\"stateId\":2}}" \
  http://localhost:8081/itsm/incidents/bulk-update
```

Ответ содержит `updated` и `revision`. Если хотя бы один указанный id не существует, пакет не применяется частично.

### Муляж страницы ITSM

Для primary source id доступна **read-only страница в стиле SimpleOne**: верхний бар, левое меню, хлебные крошки, вкладки «Детали / История / Связанные», сгруппированные поля и правая лента активности. Функциональность декоративная, данные — снимок SSR без секретов:

```text
http://localhost:8081/itsm/incidents/<primary-id>/view
```

Ссылка **«Открыть в ITSM»** в диалоге использует настроенный муляж. Например, проверить страницу выбранного выше id:

```bash
curl --fail-with-body --silent --show-error \
  "http://localhost:8081/itsm/incidents/${MOCK_INCIDENT_ID}/view"
```

## AI: локальный vLLM и классический API

AI-помощник необязателен и не участвует в генерации или синхронизации. Есть два режима запуска:

- **vllm** — локальный контейнер на этом же сервере. `start.sh` автоматически выбирает NVIDIA/CUDA, Intel XPU или CPU/llama.cpp и скачивает модель в `./models/<name>`; кэш — `./cache/huggingface`;
- **api** — классический OpenAI-совместимый API провайдера: DeepSeek, OpenAI и т.п. App обращается к нему по `AI_BASE_URL`; никакого Tailscale и внешнего vLLM в схеме нет.

Режим выбирается `./start.sh --mode=vllm|api` или переменной `AI_MODE` в `.env`.

```text
локальный vllm:
  app :8080 → vllm-контейнер :8000 → CUDA / Intel XPU / CPU llama.cpp
                                     └── ./models/<name> (bind mount проекта)

api:
  app :8080 → https://api.deepseek.com (или OpenAI-compatible endpoint)
```

| Переменная | Значение по умолчанию |
| --- | --- |
| `AI_MODE` | `auto` (`api` / `vllm`) |
| `AI_ENGINE` | `auto` (`nvidia` / `intel` / `cpu`) |
| `AI_PROVIDER` | `custom` (`deepseek` / `openai` / `custom`) |
| `AI_BASE_URL` | для api: например `https://api.deepseek.com` |
| `AI_MODEL` | для api: `deepseek-chat` (в vllm задаётся конфигом) |
| `AI_API_KEY` | ключ классического API; пусто для локального vLLM |
| `AI_TIMEOUT_MS` | `60000` (vllm: 120000–300000) |
| `AI_MAX_TOKENS` | `700` |
| `AI_FALLBACK` | `true` |
| `AI_RATE_LIMIT_PER_MIN` | `10` |
| `ASSISTANT_ENABLED` | `true` |
| `ASSISTANT_RATE_LIMIT_PER_MIN` | `20` |
| `ROUTING_ENABLED` | `true` |
| `ROUTING_RATE_LIMIT_PER_MIN` | `30` |
| `ROUTING_TIMEOUT_MS` | `20000` |
| `POSTMORTEM_ENABLED` | `true` |
| `POSTMORTEM_RATE_LIMIT_PER_MIN` | `10` |
| `POSTMORTEM_TIMEOUT_MS` | `60000` |
| `QUALITY_ENABLED` | `true` |
| `QUALITY_AI_ENABLED` | `true` |
| `QUALITY_AI_RATE_LIMIT_PER_MIN` | `5` |
| `QUALITY_AI_TIMEOUT_MS` | `20000` |
| `DEMO_MIN_INTERVAL_MS` | `3000` |
| `DEMO_MAX_INTERVAL_MS` | `9000` |
| `DEMO_BATCH_MIN` | `1` |
| `DEMO_BATCH_MAX` | `3` |
| `PUBLIC_ORIGIN` | пусто |
| `COOKIE_SECURE` | `false` |
| `SESSION_TTL_MS` | `604800000` |

В `vllm`-режиме compose переопределяет `AI_BASE_URL` на `http://vllm:8000/v1`,
а `AI_MODEL` берёт из `config/ai/<engine>.env`.

### Как выбирается провайдер и откуда берётся ключ

Провайдер **не определяется автоматически**. App — обычный OpenAI-клиент: он берёт
`AI_BASE_URL`, добавляет `/chat/completions`, подставляет `AI_MODEL` и, если ключ
не пустой, отправляет `Authorization: Bearer <AI_API_KEY>`. Куда идти, задаёт
пользователь:

- `--provider=deepseek` → `https://api.deepseek.com` + `deepseek-chat`;
- `--provider=openai` → `https://api.openai.com/v1` + `gpt-4o-mini`;
- `--provider=custom --base-url=... --model=...` — любой совместимый endpoint;
- для `vllm` база и модель берутся из `config/ai/<engine>.env`.

Приоритет параметров:

```text
параметры start.sh  >  переменные окружения  >  .env  >  значения по умолчанию
```

`start.sh` парсит аргументы, экспортирует `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`
и запускает `docker compose`. Compose подставляет их в окружение контейнера app.
Если ключ не передан нигде, он пустой: для keyless vLLM это нормально, для
DeepSeek/OpenAI провайдер вернёт `401`.

Безопасность:

- ключ из `--api-key` виден в истории shell и списке процессов — для продакшена
  лучше `.env` с правами `600` или внешний secret manager;
- `.env` в `.gitignore`, в образ не попадает;
- `.env.example` — это только шаблон с именами переменных и пустыми значениями,
  без секретов. `start.sh` копирует его в `.env` при первом запуске; он же
  документирует, какие переменные нужны для `docker compose` без скрипта.

Ключ не нужен локальному vLLM: в vllm-режиме `AI_API_KEY` принудительно пустой.

### Локальные модели и конфиги

Параметры движка разделены по железу в `config/ai`:

| Файл | Движок | Модель |
|---|---|---|
| `config/ai/nvidia.env` | vLLM CUDA | Qwen2.5-7B-Instruct-AWQ |
| `config/ai/intel.env` | vLLM XPU | Qwen2.5-7B-Instruct-GPTQ-Int4 |
| `config/ai/cpu.env` | llama.cpp | Qwen2.5-7B-Instruct-Q4_K_M |

`start.sh --mode=vllm` определяет железо, подхватывает нужный файл и запускает
`docker-compose.vllm.yml` + соответствующий override. Модель скачивает
init-контейнер `model-init` в `./models/<VLLM_MODEL_NAME>`; повторный запуск
модель не качает. Удалить модель и скачать заново:

```bash
rm -rf models/qwen2.5-7b-awq
./start.sh --mode=vllm
```

Переопределить модель без правки конфига:

```bash
./start.sh --mode=vllm --model-id=Qwen/Qwen2.5-3B-Instruct \
  --model-name=qwen2.5-3b --max-model-len=4096
```

Для CPU нужен `--model-file` (GGUF); для GPU-моделей — snapshot. Офлайн-режим:
положить готовую модель в `./models/<name>` и запустить с
`MODEL_SKIP_DOWNLOAD=1`.

### Ошибки, fallback и лимиты

AI вызывается только по запросу `POST /api/v1/ai/summary` авторизованного координатора — общая сводка или сводка по `caseId`. AI ничего не изменяет в инцидентах и не блокирует синхронизацию.

При недоступном AI-бэкенде, таймауте, 401/429 или некорректной модели система продолжает работать. По умолчанию (`AI_FALLBACK=true`) ответ — `200` с детерминированной сводкой и `fallback:true, reason:{code,message}`; UI подписывает её **«Автоматическая сводка»**, а не как ответ ИИ. При `AI_FALLBACK=false` возвращается `502`/`503` с `{"error":..., "code":...}`; тело ответа провайдера и ключи наружу не попадают.

На пользователя действует лимит `AI_RATE_LIMIT_PER_MIN` запросов в минуту (по умолчанию 10; `0` отключает). При превышении — `429` с `{"error":"Слишком много запросов ИИ; повторите позже","code":"rate_limited"}`. Лимит хранится в памяти процесса.

Локальная модель задаётся в `config/ai/<engine>.env`. Если 7B не влезает в память, уменьшите `VLLM_MAX_MODEL_LEN`/`VLLM_GPU_MEMORY_UTILIZATION` или выберите меньшую модель через `--model-id`.

`PUBLIC_ORIGIN` задаёт ожидаемый origin для проверки заголовка `Origin` у mutating-запросов (например `https://pulse.example.com`, без завершающего `/`). Если переменная пуста, ожидаемый origin собирается из `Host` запроса и схемы `COOKIE_SECURE` (`http`/`https`). Настройка нужна за обратным прокси, когда внешний origin не совпадает с `Host`.

Безопасная проверка структуры Compose без подстановки локальных значений и без вывода конфигурации в общий журнал:

```bash
docker compose config --no-interpolate >/dev/null
```

### Спросить дашборд

Кнопка **«Спросить»** справа снизу (или `Ctrl+K` / `Cmd+K`) открывает
немодальную панель. Пользователь пишет фразу, модель превращает её в
JSON-фильтр, а сервер исполняет фильтр обычным кодом.

```text
"критичные без команды"
  → groups=["critical"], needsTeam=true
  → сервер: count=3, caseIds=[...]
  → UI: чипы + "Найдено 3" + [Показать]
```

Важно:

- модель получает **только фразу и справочники** продуктов/регионов/сервисов/команд;
  записи инцидентов и счётчики ей не передаются;
- модель не считает и не отдаёт данные — только `intent:filter` и whitelisted-поля;
- сервер валидирует каждое поле/оператор и исполняет фильтр сам;
- дашборд меняется только после **«Показать»**; до этого виден предпросмотр;
- активный фильтр виден чипом `ИИ-фильтр: N` и сбрасывается отдельно;
- история запросов живёт только в текущей вкладке; на сервере хранится только
  хэш фразы в in-memory кэше на 10 минут, без текста и без записи в БД;
- если модель не уверена, она задаёт уточняющий вопрос с вариантами;
- `ASSISTANT_ENABLED=false` убирает кнопку и отключает endpoint.

Разрешённые поля: `groups`, `stateIds`, `priorityIds`, `regions`, `products`,
`services`, `teams`, `needsTeam`, `unassignedCoordinator`, диапазоны
`affectedUsers`/`reportCount`, `sla`, `dueWithinMinutes`,
`startedWithinMinutes`, `isNeedUp`/`isMaster`/`isEffect`, `text`, `sort`, `limit`.

```http
POST /api/v1/assistant/parse
Cookie: incident_pulse_session=...
Content-Type: application/json

{"text":"что горит по SLA в Московской области"}
```

Ответ:

```json
{
  "intent": "filter",
  "filter": { "regions": ["Московская область"], "sla": "risk_or_overdue" },
  "explanation": "SLA-риск или просрочка в Московской области",
  "confidence": 0.86,
  "matched": { "count": 4, "active": 4, "closed": 0, "truncated": false, "caseIds": ["..."] }
}
```

### Маршрутизация команд

В `MTS_TEAMS` 12 команд. Для маршрутизации координаторская
`КЦ ИТ Координаторы Массовых Инцидентов` исключена: подсказывать назначение
в неё бессмысленно. Остальные 11 — целевые.

Подсказка встроена в существующий блок **«Команда»** диалога:

- для активного инцидента без команды автоматически запрашивается одна
  рекомендация (только при открытии карточки, не в фоне);
- показывается команда, одна строка обоснования и источник — `ИИ` или `правило`;
- **ничего не назначается автоматически** — координатор жмёт «Назначить»;
- «Другая» переводит фокус в ручной select;
- если уверенной подсказки нет, блок просто скрыт.

Очередь «Без команды: N» в тулбаре открывает немодальный drawer:

- список всех активных инцидентов без команды, а не только группы
  `coordination` (критические и высокие тоже попадают);
- сортировка: приоритет, затем дедлайн;
- подсказки грузятся лениво по 2 одновременно, с кэшем;
- «Назначить» использует тот же `POST /api/v1/incidents/:id/team` с `expectedVersion`;
- «Открыть» открывает обычную карточку;
- закрывается по Esc/крестику, не блокирует дашборд.

```http
POST /api/v1/routing/suggest
Content-Type: application/json

{"caseId":"..."}
```

```json
{
  "caseId": "...",
  "version": 1,
  "team": "МТС ИТ Поддержка KION",
  "rationale": "Инцидент связан с воспроизведением видео в KION.",
  "confidence": 0.95,
  "source": "ai"
}
```

Модель получает только текущий кейс: `title`, `product`, `service`,
`scenario`, `description`; без пользователей, счётчиков и других инцидентов.
Ответ строго JSON, команда проверяется по `MTS_TEAMS`. Если AI недоступен,
вернул неизвестную команду или низкую уверенность — срабатывает
детерминированное правило по продукту/сценарию (`source: "rule"`). Если и
правила нет — `team: null`, UI оставляет ручной выбор.

Кэш — 10 минут по `caseId + version`; лимит `ROUTING_RATE_LIMIT_PER_MIN`;
таймаут `ROUTING_TIMEOUT_MS`. Флаг `ROUTING_ENABLED=false` убирает кнопку,
подсказку и endpoint. Ошибка подсказки дешёвая: назначение всё равно делает
человек.

### Постмортем и ретро

История кейса уже пишется в `history`; постмортем делает её читаемой.
Audit-журнал для этого не используется: там административные действия, а не
жизненный цикл инцидента.

В панели **«ИИ-анализ»** есть кнопка **«Постмортем»**. Для активного кейса она
называется «Промежуточный разбор», для завершённого — «Собрать постмортем».
Генерация запускается **только по клику**, не при открытии карточки.

Результат раскрывается в диалоге:

- **Что произошло** — краткий итог;
- **Таймлайн** — фактические события из `store.listHistory()`: время, автор,
  действие, команда/статус/приоритет;
- **Почему** — причины и гипотезы с evidence и уровнем уверенности;
- **Что улучшить** — конкретные действия, владелец и приоритет;
- **Что прошло хорошо** и **Открытые вопросы** — если есть.

Таймлайн строится **детерминированно на сервере** из истории. Модель не
переписывает события — она добавляет summary, причины и улучшения. Это защищает
от галлюцинаций с датами и действиями.

```http
POST /api/v1/postmortem
Content-Type: application/json

{"caseId":"..."}
```

Ответ:

```json
{
  "caseId": "...",
  "version": 3,
  "timeline": [
    {"at": 1763690000000, "actor": "Даниил", "event": "Взял инцидент в координацию", "kind": "fact"}
  ],
  "summary": "Инцидент обработан за 7 минут...",
  "causes": [
    {"text": "Задержка назначения команды", "evidence": "claim → team: 7 минут", "confidence": "medium"}
  ],
  "improvements": [
    {"action": "Автоматически предлагать команду", "owner": "Координация", "priority": "high"}
  ],
  "wentWell": ["SLA не нарушен"],
  "openQuestions": [],
  "source": "ai",
  "generatedAt": 1763690120000
}
```

Если AI недоступен, возвращается `source: "fallback"` с фактическим таймлайном,
без выдуманных причин; блок «Почему» пишет, что причина не зафиксирована.
Кнопки **«Скопировать»** и **«Скачать .md»** экспортируют Markdown.

Кэш — 10 минут по `caseId + version + история`; лимит
`POSTMORTEM_RATE_LIMIT_PER_MIN`; таймаут `POSTMORTEM_TIMEOUT_MS`;
флаг `POSTMORTEM_ENABLED=false` скрывает кнопку и endpoint.

### Линтер качества и AI semantic scan

`GET /api/v1/quality` быстро считает детерминированный отчёт по canonical cases:

- активный кейс без команды/координатора;
- пустой/шаблонный `solution`, solution у активного кейса;
- дубли по продукту/региону и похожему title;
- конфликт description со статусом;
- пропущенные поля и просроченный SLA без эскалации.

`score` считается сервером: `100 - 12*high - 6*medium - 2*low`;
findings содержат message/evidence/relatedCaseId. В UI — чип «Качество N»,
бейджи на карточках и drawer с кольцом score, фильтрами и переходом к кейсу.

Кнопка **«Проверить смысл»** вызывает `POST /api/v1/quality/scan`
(опционально `{caseIds:[]}`, до 20). AI проверяет только выбранные кейсы
по solution/description/status, возвращает strict JSON с evidence; сервер
валидирует, дедуплицирует с правилами и пересчитывает score. AI недоступен →
`source:"rules"`, `aiSkipped:true`, без 5xx. Это on-demand, не на каждом refresh;
кэш по `caseId+version+solution/description`, rate limit POST.

Флаги: `QUALITY_ENABLED`, `QUALITY_AI_ENABLED`, `QUALITY_AI_RATE_LIMIT_PER_MIN`,
`QUALITY_AI_TIMEOUT_MS`.

## Тесты

Тесты используют только встроенный `node:test` и временные каталоги ОС; серверы не запускаются, зависимости не нужны:

```bash
cd services/app && npm test
cd services/itsm-mock && npm test
```

Покрыто: агрегация `affectedUsers`/`activeAffectedUsers` и автоприоритет, взаимоисключающие группы отображения, закрытые источники, ручной override, `STATUS_TRANSITIONS`, идемпотентность `applyDelta`, stale и пустой delta без роста версий, `resetSyncState`, миграция ролей и первый администратор, валидация mock PATCH, карантин `state.json`, эндпоинты `critical`/`reset`, каденция критических событий на 40 tick-ах, keyless-клиент vLLM, очистка Qwen thinking-блока, whitelist-валидация и исполнение фильтров, парсер ассистента и отказ от неизвестных полей, fallback-правила маршрутизации и валидация команды по `MTS_TEAMS`, нормализация истории и fallback постмортема, проверка fact/hypothesis-полей, deterministic quality rules/score, AI semantic merge/fallback, targeted notifications/SSE.

## Постоянное хранение и сброс

| Volume | Точка монтирования | Содержимое |
| --- | --- | --- |
| `mock-data` | `/data` в `itsm-mock` | `state.json`: текущие записи, версии и ревизия |
| `app-data` | `/data` в `app` | SQLite: пользователи, сессии, raw records, canonical cases, история и метаданные |

`docker compose stop`, `docker compose down`, повторный `docker compose up --build` и пересоздание контейнеров не удаляют named volumes. Поэтому при повторном запуске сохраняются ревизия mock, случаи, пользователи и история. Существующий volume не становится пустым сам по себе.

Для полного сброса к пустому начальному состоянию:

```bash
docker compose down --volumes
docker compose up --build
```

**Внимание:** `down --volumes` необратимо удаляет записи mock, пользователей, сессии, canonical cases и историю.

Если ревизия mock оказалась меньше сохранённой в app (пересоздали mock, очистили его volume или выполнили `demo/reset`), app получает от mock `400` с `code:"revision_ahead"`. App очищает `raw_incidents` и `cases` (история удаляется каскадом), сбрасывает `itsmRevision` в 0, **ровно один раз** перечитывает состояние с `since=0`, применяет его и рассылает клиентам `sync.recovered`. Пользователи, сессии и настройки при этом сохраняются.

Повреждённый `state.json` mock (невалидный JSON или нарушение схемы) не мешает запуску: файл переименовывается в `state.json.corrupt-<epochMs>`, mock стартует с пустого состояния и пишет предупреждение в журнал. Атомарная запись через временный файл и `rename` сохраняется.

## Завершение локальной сессии curl

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --cookie "$COOKIE_JAR" \
  --cookie-jar "$COOKIE_JAR" \
  http://localhost:8080/api/v1/auth/logout

rm -f "$COOKIE_JAR"
```

## Основные параметры Compose

| Сервис | Контейнер / хост | Основные настройки |
| --- | --- | --- |
| `app` | `3000 / 8080` | `STATIC_DIR=/web`, `ITSM_MOCK_URL=http://itsm-mock:3001`, `POLL_INTERVAL_MS=2000`, `DEMO_GENERATION=true`, `AI_BASE_URL=https://api.deepseek.com`, `AI_MODEL=deepseek-chat`, `AI_FALLBACK=true`, `AI_RATE_LIMIT_PER_MIN=10`, `ASSISTANT_ENABLED=true`, `ASSISTANT_RATE_LIMIT_PER_MIN=20`, `ROUTING_ENABLED=true`, `ROUTING_RATE_LIMIT_PER_MIN=30`, `ROUTING_TIMEOUT_MS=20000`, `POSTMORTEM_ENABLED=true`, `POSTMORTEM_RATE_LIMIT_PER_MIN=10`, `POSTMORTEM_TIMEOUT_MS=60000`, `QUALITY_ENABLED=true`, `QUALITY_AI_ENABLED=true`, `QUALITY_AI_RATE_LIMIT_PER_MIN=5`, `QUALITY_AI_TIMEOUT_MS=20000`, `DEMO_MIN_INTERVAL_MS=3000`, `DEMO_MAX_INTERVAL_MS=9000`, `DEMO_BATCH_MIN=1`, `DEMO_BATCH_MAX=3`, `PUBLIC_ORIGIN=`, `SESSION_TTL_MS=604800000` |
| `itsm-mock` | `3001 / 8081` | `DATA_DIR=/data`, пустое начальное состояние на новом volume |

`app` и `itsm-mock` собираются из корневого build context; локальный vLLM поднимается отдельными `docker-compose.vllm*.yml` только в `--mode=vllm`. `app` стартует после успешного healthcheck mock через `depends_on` с `service_healthy`; недоступный AI-бэкенд не блокирует запуск и уходит в AI-fallback.
