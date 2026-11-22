# Incident Pulse — итоги production-review

Дата: 2026-11-22. Проверяли: 5 независимых ревью (security, API/backend, frontend/UX,
AI/integrations, ops/release) + сквозное ручное/автоматизированное прощупывание
интерфейса и API. Исходные подробные отчёты лежат локально в .review/ (в git не
попадают); здесь — сведённый реестр и статусы.

## Коротко

- Исходно: 101 app-тест и 14 mock-тестов зелёные, но релиз блокировали открытая
  саморегистрация с выдачей admin, неаутентифицированный mock на публичном порту,
  зашитые COOKIE_SECURE=false / DEMO_GENERATION=true, устаревший образ после
  start.sh и healthcheck, не проверяющий БД.
- Сейчас: P0/P1 закрыты или закрыты организационно (production-runbook,
  bootstrap-скрипт, env-переключатели). 107 app-тестов и 14 mock-тестов проходят.
  Образы пересобраны, production-стек перезапущен и проверен: healthy,
  mock слушает только 127.0.0.1, /ready=200, статика совпадает с HEAD.
- Осталось: решения по продуктовой модели (открытая регистрация, публичная стена,
  права координаторов), а также технический backlog P2/P3: SSE replay, O(n²) триаж,
  пагинация/retention, SSO/MFA, e2e/CI.

## Статусы

- FIXED — исправлено в этом изменении.
- MITIGATED — риск снижен настройкой/документацией/скриптом, но остаётся решение.
- BACKLOG — осознанно отложено, зафиксировано.
- DECISION — нужно продуктовое/эксплуатационное решение.

## Блокеры и критические (P0/P1)

| ID | Область | Проблема | Статус |
| --- | --- | --- | --- |
| SEC-01 / OPS-02 | Auth | Открытая регистрация; первый пользователь получает admin; нет выключателя | FIXED: REGISTRATION_ENABLED (демо — true, production — false), bootstrap-скрипт, REGISTRATION_TOKEN, rate-limit, пароль >= 8, скрытие вкладки |
| SEC-02 / AI-01 / OPS-01 | ITSM mock | Mock без auth опубликован на 0.0.0.0:8081; demo/reset стирает cases/history | FIXED: MOCK_BIND по умолчанию 127.0.0.1; app делает backup перед destructive reset; mock не публикуется наружу |
| SEC-03 / OPS-03 | TLS | Нет TLS, COOKIE_SECURE зашит false, HSTS не было | MITIGATED: COOKIE_SECURE через env, HSTS/Permissions-Policy в HTML, runbook с nginx/TLS; TLS остаётся обязанностью прокси |
| OPS-04 | Demo | DEMO_GENERATION=true зашит в compose | FIXED: переменная окружения, default true для demo, runbook требует false |
| OPS-05 | Release | start.sh не пересобирал образы; работал stale wall.js | FIXED: сборка по умолчанию, --no-build для рестарта, version в /health и /ready |
| OPS-06 / API-15 | Health | /health всегда 200, не проверял БД; startup ждал mock | FIXED: добавлен /api/v1/ready с проверкой SQLite; compose/start.sh используют его; /health остался liveness |
| API-01 | Sync | Одна невалидная запись ITSM блокировала синхронизацию навсегда | FIXED: per-record валидация, dead-letter sync_failures, revision продвигается, warning в syncError; admin endpoint /admin/sync-failures |
| P1-01 / API-06 | SSE | После реконнекта доска и уведомления оставались устаревшими; нет replay | MITIGATED: клиент перечитывает incidents/notifications при onopen и обновляет открытый диалог; серверный Last-Event-ID/replay остаётся в backlog |
| P1-02 | Auth/UI | При истечении сессии в браузере оставались уведомления предыдущего пользователя | FIXED: resetNotifications в setUser(null)/handleUnauthorized; ошибка загрузки показывается, а не маскируется пустотой |

## Высокие (P2)

| ID | Область | Проблема | Статус |
| --- | --- | --- | --- |
| SEC-04 | Auth | Пароль из 1 символа | FIXED: минимум 8 при регистрации (для старых паролей вход сохранён) |
| SEC-05 / OPS-21 | Auth | Brute-force: лимит только IP+login, за прокси — DoS админа | BACKLOG: нужен trusted proxy / per-account+per-IP / MFA |
| SEC-06 | Auth | Нет rate-limit регистрации, scrypt-CPU DoS | FIXED: 20 регистраций/час с адреса; остаётся общий лимит на прокси |
| SEC-07 / AI-06 | AI | Квоты AI на пользователя, обход через регистрацию | MITIGATED: регистрацию можно выключить; глобального бюджета нет — BACKLOG |
| SEC-08 / API-05 | Authz | Любой координатор может забрать/переназначить/слить чужой кейс | FIXED частично: claim чужого назначения -> 409 already_assigned; reassign/merge остаются доступны координаторам (продуктовое решение) |
| SEC-09 / API-16 / OPS-30 | SSE | Поток не закрывался при logout/удалении пользователя | FIXED: SSE-клиент хранит hash сессии; logout/admin logout/delete закрывают потоки |
| SEC-13 | Static | Вне Docker default STATIC_DIR раздавал исходники | FIXED: в production STATIC_DIR обязателен; Docker задаёт /web |
| SEC-14 / API-11 | API | Произвольная team, 500 на огромный deadline, коэрция типов | FIXED: team только из MTS_TEAMS; deadline range -> 400; empty env -> fallback; строгая типизация частично |
| SEC-15 | CSRF | Нет CSRF-токена, Origin проверяется только при наличии | BACKLOG: SameSite=Lax + Origin + JSON content-type сейчас; нужен токен при отказе от Lax |
| SEC-16 | Proxy | /itsm терял CSP/XFO | FIXED: HTML из прокси получает те же security headers |
| SEC-17 / SEC-24 | Headers | Не было HSTS, Permissions-Policy, COOP/CORP, object-src | FIXED: добавлены HSTS, Permissions-Policy, COOP/CORP, object-src none |
| SEC-18 / AI-03 | AI | Prompt injection через поля инцидента/историю | BACKLOG: нужны разделители/маркировка данных, ограничение длины, проверка выхода |
| SEC-19 / OPS-11 | Public | /wallboard и /wall/events без лимитов, SSE без cap/backpressure | FIXED частично: cap MAX_SSE_CLIENTS, обрыв медленных клиентов; rate-limit публичных endpoint — BACKLOG |
| SEC-20 | Sync | POST /sync/itsm доступен координатору, audit называет sync.manual | DECISION: оставить координаторам (ручная синхронизация) или requireAdmin |
| SEC-21 / OPS-27 | Docker | Нет read_only/cap_drop/no-new-privileges/limits | FIXED: read_only, tmpfs, cap_drop ALL, no-new-privileges, pids/mem limits, log rotation, restart |
| SEC-26 | Audit | Аудит только admin/sync; нет login/logout/fail, retention | BACKLOG |
| SEC-28 / AI-15 | AI | Нет лимитов длины summary/attentions | BACKLOG |
| AI-02 | AI | Невалидный JSON модели показывался как успешная ИИ-сводка | FIXED: bad_json -> AiError -> fallback (тесты) |
| AI-04 | AI | Нет лимитов размера промпта/полей | BACKLOG |
| AI-05 / API-07 | Triage | O(n²) на GET /triage, блокирует event loop | BACKLOG: нужен кэш по revision/группировка/лимит пар |
| AI-07 | Postmortem | Причины/evidence не сверяются с таймлайном | BACKLOG |
| AI-09 | Canonical | team/coordinator только из primary source | DECISION/BACKLOG: зависит от контракта ITSM; тест на multi-source нужен |
| AI-10 | Mock | Неполная валидация state.json, PATCH без revision | BACKLOG |
| AI-12 | AI cache | Fallback/rule кэшируются на 10 минут | BACKLOG |
| API-02 | Sync | Смена correlationKey в ITSM не перегруппировывает кейсы | BACKLOG: риск дублей при изменении ключа upstream |
| API-03 | Merge | team_override после merge игнорировал внешние изменения team | FIXED частично: null-team больше не залипает; для non-null остаётся правило «merge сохраняет команду» |
| API-04 | Lifecycle | Закрытые кейсы менялись через API | FIXED: claim/priority/deadline/override -> 409 case_closed; status 7->10 разрешён |
| API-08 | Shutdown | SIGTERM зависал на in-flight AI; exit code терялся | FIXED: force-exit через 5 c, корректный код, closeStore после операций; отмена fetch — BACKLOG |
| API-09 | Config | Пустые env трактовались как 0 (случайный PORT, отключение лимитов) | FIXED: пустое значение -> fallback |
| API-10 | API | expectedVersion опционален для priority/deadline/team/status | BACKLOG: last-write-wins задокументирован; для строгой модели — If-Match |
| API-13 / OPS-29 | Scale | Нет пагинации /incidents, полный refetch на SSE | BACKLOG |
| API-14 / OPS-26 | Retention | Нет retention audit/history/notifications, нет backup в README | MITIGATED: runbook backup/restore + auto-backup перед reset; retention — BACKLOG |
| API-17 | Demo | Ручной sync не идемпотентен, retry создаёт инциденты | BACKLOG: Idempotency-Key |
| API-18 | Data | DATA_DIR/SQLite были 755/644 | FIXED: 0700 на каталог; файлы БД — средствами SQLite (см. runbook) |
| API-19 | Runtime | Нет unhandledRejection/uncaughtException | FIXED: handlers -> graceful shutdown |
| API-21 | Time | Zone-less timestamp трактуется как UTC | BACKLOG: требовать Z/offset |
| P2-01 | UI | «Открыть дубли» из карточки открывало панель под модальным dialog | FIXED: dialog закрывается перед openTriagePanel |
| P2-02 | UI | AI-сводка предыдущего кейса попадала в новый | FIXED: поколение запроса + проверка activeId/seq |
| P2-03 | UI | История предыдущего кейса попадала в новый | FIXED: historySeq + activeId |
| P2-04 | UI | Двойной submit «Взять в работу» | FIXED: actionBusy + блокировка take-work |
| P2-05 | UI | SSE-рендер сбрасывал выбранный, но не сохранённый приоритет | FIXED: dirty-флаг priority-select |
| P2-06 | A11y | Контраст light/dark ниже WCAG AA | FIXED: токены --muted/--faint/--group-* затемнены; повторный аудит 0 провалов (dark) и только color-mix false positive (light) |
| P2-07 | UI | Горизонтальный overflow шапки 320–430 px | FIXED: icon-only logout, скрытие avatar/live-text/divider, 320 px; проверено 320/375/414 => scrollWidth == viewport |
| P2-08 | UI | Ошибка загрузки уведомлений выглядела как «назначений нет» | FIXED: error отображается в empty-state, loaded=false |
| P2-09 | UI | Toast/критический баннер не видны при открытом dialog | FIXED: toast переносится внутрь dialog (top layer); проверено elementFromPoint |
| P2-10 | Wall | Время/смена на стене зависели от TZ браузера | FIXED: Europe/Moscow во всех форматтерах и shiftLabel |
| P3-07 | Wall | Стена обрезалась на 1440x600; 1280x720 уходил в одноколоночный скролл | FIXED: breakpoint 1100, short-height scroll, 1280x720 проверен — scrollHeight=720, 3 критические строки без наложения |
| OPS-07 | Ops | Нет restart policy/limits/log rotation | FIXED |
| OPS-08 | Ops | Нет production-runbook | FIXED: docs/production.md |
| OPS-09 | Config | AI_BASE_URL=127.0.0.1 внутри контейнера недостижим | MITIGATED: README/таблица исправлены, runbook; дефолт оставлен для локального vLLM — DECISION |
| OPS-10 | Public | /wall публична, без feature-flag | DECISION: закрыть на прокси или добавить PUBLIC_WALL |
| OPS-11 | SSE | Нет per-IP лимита | MITIGATED cap; per-IP — BACKLOG |
| OPS-12 | vLLM | privileged, root в vLLM-стеке | BACKLOG (не production-профиль app) |
| OPS-13 | Supply | Плавающие теги образов/моделей, нет digest pinning | BACKLOG |
| OPS-14 | Model | MODEL_SKIP_DOWNLOAD ставит .complete на пустой каталог | BACKLOG |
| OPS-15 | Model | model-init создаёт root-owned модели | BACKLOG |
| OPS-16 | AI egress | Описания/имена уходят внешнему AI | DECISION: runbook требует решить DPA/self-host |
| OPS-17 | CI | Нет CI/e2e | BACKLOG |
| OPS-18 | start.sh | wait_engine до 30 мин, плохая диагностика | BACKLOG |
| OPS-19 | Observability | Нет request-id/metrics/access-log | BACKLOG |
| OPS-20 | Docs | README/.env.example расходились с кодом | FIXED частично: ключевые дефолты/тесты/регистрация/cookie исправлены; полный env-аудит — BACKLOG |
| OPS-22 | Secrets | .env создавался 644 | FIXED: umask 077/chmod 600 |
| OPS-23 | Secrets | start.sh печатал AI_BASE_URL с credentials | FIXED: redact_url |
| OPS-24 | Static | Нет gzip/ETag | BACKLOG |
| OPS-25 | Compose | vLLM-варианты хрупкие | BACKLOG |
| OPS-28 | start.sh | Нет проверки daemon/портов/trap | BACKLOG |
| OPS-31 | Docs | Нет OpenAPI/LICENSE/CHANGELOG | BACKLOG |
| OPS-32 | Build | build context включает prototype/docs/.review | BACKLOG |
| OPS-33 | Wall | TZ стены | FIXED (см. P2-10) |

## Средние/низкие UI и доступность

- FIXED: skip-link был hidden и недоступен с клавиатуры; теперь показывается по focus.
- FIXED: backdrop-закрытие формы (closedby=any) убрано, чтобы не терять введённое решение/дедлайн.
- FIXED: reduced-motion и print-стили добавлены.
- FIXED: toast больше не дублирует announce? Осталось два live-region — BACKLOG P3.
- FIXED: AI-фильтр сбрасывает «Без координатора», иначе список расходился со счётчиком.
- FIXED: история merge/correlation_key показывает русские подписи и детали.
- FIXED: плюрализация announce и хвост «0 источников · ».
- FIXED: mark-read при ошибке больше не делает вид, что уведомление прочитано.
- FIXED: мобильный assistant FAB стал icon-only, «В работе» FAB скрыт на телефоне.
- FIXED: отдельный блок «Не принятые назначения» удалён; вкладка переименована в «Мои»,
  SLA-таймеры в списке тикают каждую секунду.
- FIXED: история уведомлений хранится в колокольчике (до 200), прочитанные не удаляются;
  при сбросе кейсов уведомления сохраняются и помечаются прочитанными.
- BACKLOG: ARIA-паттерн вкладок админки, focus management assistant/routing/triage,
  aria-live для AI-сводки, N+1 запросов истории в «Назначенные мне», debounce/точечный
  рендер списка, datetime-local без подписи зоны, print-проверка PDF.
- BACKLOG: на стене нет pause для автопереключения фаз, нет main/h1-анонсов данных
  (main/h1 добавлены, live-region изменений — нет), мелкий шрифт 8.5–9.5 px.

## Что именно изменено в коде

- services/app/src/server.js: readiness, security headers, registration flag/token/
  rate-limit, strict env parsing, team allowlist, закрытые кейсы, claim conflict,
  deadline range, SSE cap/revocation/backpressure, backup при revision reset,
  dead-letter warning, admin sync-failures, graceful shutdown/exit code, HSTS.
- services/app/src/store.js: sync_failures, per-record applyDelta, backup VACUUM INTO,
  private DATA_DIR, null team_override.
- services/app/src/auth.js: минимальная длина пароля при регистрации.
- services/app/src/ai.js: bad_json вместо «сырого текста как summary», извлечение
  JSON из fenced/пояснённого ответа.
- app.js: SSE reconnect refresh, notifications reset/error, stale AI/history guards,
  double-submit lock, priority dirty, triage-dialog close, toast в top layer,
  AI-filter reset, merge labels, plural/empty-source, mark-read rollback,
  registration UI, mobile.
- styles.css: контрастные токены, мобильная шапка, icon logout, skip-link,
  reduced-motion, print, FAB.
- wall.js/wall.css/wall.html: MSK, action labels, overdue, «обновлено только что»,
  breakpoint 1100, short-height scroll, faint colors, main/h1/theme-color.
- docker-compose.yml: mock bind 127.0.0.1, env overrides, restart/logging/limits,
  read_only/cap_drop/no-new-privileges, healthcheck /ready.
- start.sh: сборка по умолчанию, --no-build, .env 600, redaction, /ready.
- scripts/create-admin.js, docs/production.md, README.md, .env.example,
  services/app/test/hardening.test.js, ai/store tests.

## Проверка

- services/app: 107/107 pass (node --test, ~10 c).
- services/itsm-mock: 14/14 pass.
- node --check для app.js/wall.js/theme.js и src/lib; bash -n start.sh.
- docker compose config --quiet — OK.
- Ручной/headless Chrome smoke на изолированном стенде: логин, карточка, claim,
  team, статус, merge, AI fallback, дубли, админка, wall.
- Responsive: 320/375/414/768/1440 — horizontal overflow отсутствует; шапка
  не обрезается. Wall 1280x720/1366x768/1920x1080 — влезает; 1440x600 — scroll
  вместо обрезки.
- A11y contrast: light/dark после правок — без подтверждённых провалов (кроме
  ложного срабатывания парсера на color-mix).
- Финальная сборка Docker (app/mock), `docker compose up -d`, healthcheck
  `/api/v1/ready` — OK; образы содержат текущие ассеты, mock опубликован на
  127.0.0.1:8081, app healthy. Проверены 320/375/414/768/1440 px и wall
  1280x720/1366x768/1920x1080; горизонтального overflow нет, wall влезает.

## Release gates

Перед выпуском обязательно:

1. Выключить DEMO_GENERATION и REGISTRATION_ENABLED, создать admin скриптом.
2. Проверить, что mock не доступен извне (MOCK_BIND=127.0.0.1, firewall).
3. TLS-прокси + PUBLIC_ORIGIN + COOKIE_SECURE=true; проверить login/CSRF.
4. Backup volumes и restore drill; healthcheck на /api/v1/ready.
5. Решить по публичной стене, правам координаторов (claim/reassign/merge) и
   AI data egress. До решения — не выставлять в интернет.

## Решения, которые нельзя принять кодом

- Открытая регистрация vs invite/SSO — продуктовая модель доступа.
- Публичная стена: нужна ли она гостям/интернету или только в офисе.
- Может ли любой координатор забирать/переназначать/объединять любой кейс.
- Внешний AI: допустима ли передача описаний/имён, нужен ли DPA/self-host.
