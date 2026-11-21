# ITSM Live Incidents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Создать общий дашборд координаторов с живым эмулятором ITSM, генерацией изменений по API, объединением дублей, автоматическим и ручным приоритетом, назначением команд, учётными записями, уведомлениями и последующим DeepSeek-помощником.

**Architecture:** Два Node.js-контейнера без gateway. `itsm-mock` начинает с пустого состояния, генерирует реалистичные записи МТС и хранит текущую ревизию. `app` получает изменения по API, объединяет связанные записи в canonical cases, хранит пользователей/историю в SQLite, выполняет действия через mock и рассылает SSE. Пользовательского файлового импорта нет. Присланные JSON — только примеры схемы, не seed данных.

**Tech Stack:** Node.js 24, встроенные `node:http`, `node:sqlite`, `node:crypto`, `fetch`, vanilla HTML/CSS/JS, Docker Compose. Внешние npm-зависимости не нужны. AI: DeepSeek Chat Completions API, модель из `DEEPSEEK_MODEL`, утверждённое текущее значение `flash`.

## Global Constraints

- Не добавлять gateway, frontend framework, отдельную СУБД, npm-зависимости или файловый импорт.
- Не создавать тестовые файлы: исходной тестовой инфраструктуры нет. Проверка — `node --check`, реальные HTTP/Docker/browser-сценарии.
- Не выполнять git commit/push/reset/rebase.
- Не изменять fixtures; они не загружаются как начальные инциденты. Mock initial state: `{ "revision": 0, "incidents": [] }`.
- Порты: app container/host `3000/8080`; mock `3001/8081`.
- API errors: `{ "error": "..." }`; timestamps frontend: epoch ms или null.
- Auth без ролей: register/login/logout/me, все координаторы равны. scrypt, SQLite sessions, HttpOnly SameSite=Lax; Secure при `COOKIE_SECURE=true`; проверять Origin для mutating requests, если передан.
- Статусы: `0=Назначен`, `2=Выполняется`, `20=Исследование ситуации`, `7=Завершен`, `10=Закрыт`. Для 0/2 `solution=null`, `completionDate=null`. Research исключён из active critical/high. Closed уходит в архив.
- Приоритеты: `4=critical`, `3=high`, `2=medium`, `1=low`. Критические строго active+effective priorityId 4.
- Автоприоритет по aggregated affectedUsers: 1–49 low, 50–499 medium, 500–999 high, >=1000 critical.
- Ручной priority override не затирается синхронизацией; поддержать возврат к auto и предупреждение о расхождении.
- Передача команде: stateId 2, убрать из coordination, сохранить priority; НЕ переводить сразу в research. Research после solution/state20, closed после 7/10.
- Ключи секретов только из env. Не записывать их в код, README, plan, Dockerfiles или передавать субагентам. `.env` и `.env.*` исключить из Git/Docker, кроме `.env.example` без значения.
- AI не блокирует sync и не меняет данные. При ошибке/отсутствии DeepSeek основная система работает; fallback называется «Автоматическая сводка», не выдаётся за ИИ.

---

### Task 1: Живой эмулятор ITSM

**Files:** только `services/itsm-mock/**`; существующие partial files перепроверить и переработать.

**Interfaces:**
- `GET /health` -> `{status:'ok'}`.
- `GET /itsm/incidents?since=<revision>` -> `{revision,generatedAt,incidents:[changed full raw records]}`. Без since вернуть все current records. Revision строго растёт только при фактическом изменении.
- `GET /itsm/incidents/:id` -> raw record или 404.
- `POST /itsm/demo/tick` -> атомарно сгенерировать следующий сценарий и вернуть `{revision,added,updated,incidents}`.
- `PATCH /itsm/incidents/:id` -> partial merge, version/revision update, `{updated,incident}`.
- `POST /itsm/incidents/bulk-update` `{ids:[...],patch:{...}}` -> атомарно обновить все указанные id или ничего; `{updated,revision}`.
- `GET /itsm/incidents/:id/view` -> простой HTML муляж ITSM без секретов.

- [ ] Убрать seed из character_problems и старый публичный POST upsert, если он был создан. Хранилище `DATA_DIR/state.json`, atomic temp+rename, сериализация mutations, persistence после restart.
- [ ] Сценарный генератор МТС: Mobile voice, МТС ID, МТС Банк, SMS, KION, МТС Cloud. Каждый tick создаёт/обновляет осмысленные записи, включая рост affectedUsers, повторный correlationKey, изменения state/team и гарантированный сценарий 10→1000 для демонстрации.
- [ ] Raw fields: id,correlationKey,header,description,productName,service,scenarioName,region,affectedUsers,reportCount,priorityId,stateId,submitDate,deadline,completionDate,assignedGroupName,coordinatorId,coordinatorName,solution,isNeedUp,isMaster,isEffect,version,updatedAt. Допускается priorityOverrideId.
- [ ] Не вызывать AI для генерации. Body limit, JSON errors, 400/404/409/413/500 без stack. package.json и Dockerfile node:24-alpine, root build context.
- [ ] Smoke: initial 0, tick creates MTS data, since revision, repeated full read no revision growth, 10→1000, partial/bulk update, restart persistence, HTML view. Не оставлять процессы/temp data.

### Task 2: Backend, aggregation, auth и действия

**Files:** только `services/app/**`; существующие partial files полностью перепроверить и переработать.

**Interfaces:**
- Auth: `POST /api/v1/auth/register|login|logout`, `GET /api/v1/auth/me`. User `{id,name,login}` без role.
- `POST /api/v1/sync/itsm`: если `DEMO_GENERATION=true`, сначала mock `/demo/tick`; затем delta sync. Poll каждые 2s только читает changes, не генерирует.
- `GET /api/v1/incidents` -> `{incidents,counts,lastSyncedAt,syncError}`. `counts`: active,critical,coordination,high,research,risk,affectedUsers.
- Canonical incident: `caseId,id,sourceIds,correlationKey,title,description,product,service,scenario,region,affectedUsers,reportCount,priority,priorityId,autoPriorityId,priorityOverrideId,prioritySource,priorityText,status,stateId,team,coordinatorId,coordinatorName,startedAt,dueAt,resolvedAt,groups,solution,isNeedUp,isMaster,isEffect,aiSummary:null,aiTeam:null,aiReason:null,aiRisk:null`.
- Actions по caseId: `POST /api/v1/incidents/:caseId/claim` `{expectedVersion}`; `/coordinator` `{coordinatorId,expectedVersion}`; `/priority` `{priorityId}`; `DELETE /api/v1/incidents/:caseId/priority-override`; `/deadline` `{deadline}`; `/team` `{team}`; `/status` `{stateId,solution}`; `GET /api/v1/incidents/:caseId/history`.
- `GET /api/v1/coordinators` -> `{coordinators:[{id,name,login}]}`.
- `GET /api/v1/events`: `event: incidents`, data `{type:'incidents.changed',added,updated,source}`; heartbeat/cleanup.
- `GET /api/v1/health` без auth для healthcheck. Static same-origin из STATIC_DIR.

- [ ] Удалить import/ingestion/demo-create старого контракта. SQLite users/sessions/raw_incidents/cases/history/metadata с WAL. Raw records upsert по id+version; stale version не перезаписывает более новую.
- [ ] Корреляция: одинаковый id = update; разные id + один correlationKey среди незакрытых = один case. Хранить вклад каждого source id; affectedUsers/reportCount пересчитывать как сумму текущих вкладов, повторная sync не удваивает. Новый случай после closed создаёт отдельный case. caseId стабилен, primary display id — earliest active source id.
- [ ] Effective/auto/manual priority по Global Constraints. При >=1000 aggregated users автоприоритет 4. Manual override сохраняется и виден.
- [ ] Команды применять атомарно ко всем sourceIds через mock bulk-update, затем sync. Оптимистичная блокировка claim/reassign через expectedVersion; конфликт 409 и актуальное состояние. History кто/когда/что изменил.
- [ ] Группы: active 0/2; research 20; closed 7/10; coordination = active и assignedGroupName отсутствует (требуется выбрать команду); critical/high только active по effective priority. Все active доступны frontend. SLA risk active и dueAt <= now+15m, включая просроченные.
- [ ] Новые critical/priority escalation/SLA/team/coordinator/sync errors производят видимые события только на реальные изменения. Хранить history для действий; SSE не отправлять при unchanged.
- [ ] Ошибки mock не роняют app; syncError не скрывать. Static traversal/body limits/cookie cleanup/shutdown.
- [ ] `node --check` всех JS и реальные HTTP smoke с mock: empty initial, register/login, sync/generate, aggregate, 10→1000, claim conflict, priority/deadline/team/status/history, SSE, persistence. Без test files и temp files в repo.

### Task 3: Frontend общего экрана

**Files:** только корневые `index.html`, `app.js`, `styles.css`; сохранить хороший текущий дизайн.

**Interfaces:** использовать только Task 2 API. Файловой загрузки нет.

- [ ] Login/register/logout, dynamic coordinator name, same-origin credentials. После auth загрузить incidents/coordinators.
- [ ] Кнопка «Синхронизировать с ITSM» вызывает sync и показывает результат. EventSource обновляет без reload, сохраняет filters/focus/dialog. syncError/stale видимы.
- [ ] Карточка: affectedUsers, reportCount, sourceIds/count, prioritySource, coordinator, team, SLA, isNeedUp/isMaster/isEffect. Сводка включает affectedUsers и счётчики canonical cases.
- [ ] Сохранить critical/coordination/high/research и добавить доступ ко всем active; archive закрытых отдельным списком/режимом. Research не дублировать в active priority groups.
- [ ] Dialog действий: claim/reassign, priority+return auto, deadline, team из списка МТС, допустимые status transitions, history, dummy ITSM link `/itsm/incidents/<primary-id>/view` через app proxy или прямой host URL только если настроен.
- [ ] После team: coordination исчезает, priority остаётся. Новый critical/escalation/SLA/team/coordinator/sync errors дают toast/banner; unchanged sync не спамит.
- [ ] AI panel: запрос сводки по кнопке после готовности Task 5; loading/error/fallback labels. Не выдумывать AI values локально.
- [ ] Accessibility: native forms/dialog, labels, keyboard/focus, live regions. Modern-web-guidance focused search/retrieve только релевантных guides, без retry loop.
- [ ] `node --check app.js`; browser smoke после integration.

### Task 4: Docker и README

**Files:** только `docker-compose.yml`, `.dockerignore`, `.gitignore`, `README.md`, `.env.example`.

- [ ] Два root build contexts, named volumes, healthchecks, app depends_on healthy mock. Mock не монтировать character_problems как seed. Fixtures не нужны контейнерам.
- [ ] App env: PORT=3000,DATA_DIR=/data,STATIC_DIR=/web,ITSM_MOCK_URL=http://itsm-mock:3001,POLL_INTERVAL_MS=2000,COOKIE_SECURE=false,DEMO_GENERATION=true. AI env через variable substitution без значения ключа: DEEPSEEK_API_KEY,DEEPSEEK_BASE_URL=https://api.deepseek.com,DEEPSEEK_MODEL=flash,DEEPSEEK_TIMEOUT_MS=15000.
- [ ] `.gitignore`/.dockerignore исключают `.env`, `.env.*` кроме `.env.example`, `.data`, node_modules, logs. `.env.example` содержит пустой DEEPSEEK_API_KEY и model flash, без реального ключа.
- [ ] README на русском: запуск, empty initial+button generation, registration, auto priority/aggregation, coordinator actions/lifecycle, direct mock API examples, ITSM dummy link, persistence, DeepSeek setup без ключа и fallback. Убрать все инструкции файлового импорта и seed 44.
- [ ] `docker compose config` после создания локального env не выводить в общий лог, чтобы не раскрыть ключ; проверять с пустым temporary env или `--no-interpolate` там, где применимо. Build после Tasks 1/2.

### Task 5: DeepSeek assistant после основных сценариев

**Files:** `services/app/src/ai.js`, точечные изменения `services/app/src/server.js`; frontend уже имеет hook из Task 3. Не начинать до прохождения core HTTP smoke.

- [ ] `POST /api/v1/ai/summary` `{caseId?}`: без caseId — краткая общая сводка, с caseId — по инциденту. Только authenticated coordinator.
- [ ] Встроенный fetch к `${DEEPSEEK_BASE_URL}/chat/completions`, Authorization Bearer из env, model `DEEPSEEK_MODEL` (текущее `flash`), timeout 15s, ограниченный prompt только с необходимыми non-secret incident fields. Требовать JSON/текст ответа и ограничивать размер.
- [ ] Общая сводка: сколько active/critical/research/SLA, affected users, 3 приоритетных внимания. Incident: ситуация, динамика, SLA, рекомендуемая команда/действие. AI ничего не меняет.
- [ ] При missing key/401/invalid model/timeout вернуть 503/502 с понятной ошибкой UI; deterministic fallback доступен отдельно и подписан «Автоматическая сводка». Не логировать Authorization/key.
- [ ] Реальный AI request выполняет контроллер локально через env, не передавая ключ агенту. Если модель отклонена провайдером, зафиксировать точный ответ и не подменять модель молча.

### Task 6: Review и端到端 acceptance

- [ ] Независимое spec/security review, исправления через субагентов.
- [ ] Docker health: initial 0; registration/login; button sync generates MTS records; все координаторы получают SSE.
- [ ] 10 users low → 1000 critical на том же case; duplicate correlation суммируется без double count; повторный revision unchanged.
- [ ] Два пользователя, claim/reassign и conflict 409; equal capabilities.
- [ ] Manual priority persists sync, return auto работает; critical deadline редактируется, risk/SLA видимы.
- [ ] Team => state2 + уходит из coordination + сохраняет priority; research только state20+solution; closed => archive; active solution/completionDate null.
- [ ] Notifications new critical/escalation/SLA/team/sync error без unchanged spam; dummy ITSM link работает.
- [ ] Restart сохраняет users/mock/cases/history. Unauthorized 401, logout инвалидирует session, malformed requests 400, mock unavailable visible syncError.
- [ ] Browser: регистрация, sync, counters, actions, second session/SSE, console без ошибок. AI smoke последним, fallback проверен отдельно.
- [ ] Не оставлять временные файлы/процессы; финальный git status и честный отчёт проверок.
