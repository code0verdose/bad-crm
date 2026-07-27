# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Security fixes are additionally published as GitHub Security Advisories; see
[`SECURITY.md`](SECURITY.md). New or changed environment variables are always listed here **and** in
[`docs/runbooks/upgrade.md`](docs/runbooks/upgrade.md), because self-hosted administrators upgrade
from this file.

---

## [Unreleased]

Nothing is released yet. The specification and the work breakdown are complete; EPIC-001 has added
the development environment on top of them. There is still no application: no HTTP endpoints, no
user interface, no Prisma schema, no image of the application, no version tag. The
`docker-compose.yml` that now exists starts the **backing services**, not Bad CRM.

### Added — EPIC-001: монорепо и среда разработки

**Монорепо и сборка**

- `package.json`, `pnpm-workspace.yaml`, `turbo.json` — pnpm-workspace с четырьмя пакетами
  (`@bad-crm/shared`, `server`, `client`, `e2e`) и кешируемым turborepo-пайплайном; корневые
  скрипты `dev`/`build`/`typecheck`/`lint`/`test`/`docker:*` — обёртки над `turbo`.
- `tsconfig.base.json` и по одному `tsconfig.json` на пакет — strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, project references, алиасы `@/*` (сервер) и
  `@app|@pages|@widgets|@units|@shared` (клиент). Одна версия TypeScript на воркспейс
  ([ADR-0022](docs/architecture/adr/0022-typescript-version-policy.md)).
- `eslint.config.js` + `eslint/bad-crm.plugin.js` — ESLint 9 flat config, единый на все пакеты, с
  архитектурными запретами (гексагональные слои сервера, слои FSD клиента, направление зависимостей
  пакетов, `prisma.*` вне persistence, raw `fetch` вне `shared/api`, `import.meta.env` вне
  `shared/config`, kebab-case + role-suffix). Прогоняется и на `test/**` через корневую задачу
  `//#lint:repo`.
- Prettier, husky, lint-staged, commitlint (Conventional Commits), `.editorconfig`, `.npmrc`,
  `.nvmrc` (Node 22.22.1).
- Покрытие тестами измеряется `@vitest/coverage-v8`; пороги из
  [`rules/testing.mdc`](rules/testing.mdc) §7 роняют сборку.

**Инфраструктура разработки**

- `docker-compose.yml` — PostgreSQL 16 + pgvector, Redis, MinIO (+ `minio-setup`), Meilisearch,
  Mailpit; профили `minimal` / `default` / `full`. Скрипты `scripts/docker/up.sh` и
  `scripts/docker/reset.sh`, команды `pnpm docker:up|down|logs|reset`.
- `packages/server/prisma/sql/00-bootstrap-roles.sql` — роли БД (`app_migrator`, `app_user`,
  `app_auth`, `backup_role`) для инварианта RLS; выполняется до первой миграции.

**Код**

- `packages/shared` наполнен: zod-примитивы (email, пароль, slug, деньги, даты, пагинация,
  сортировка, локаль, таймзона), branded id, каталог permissions с `can()`, коды ошибок, `Result`.
- `packages/server/src/infrastructure/bootstrap` — разбор окружения одной zod-схемой на старте,
  `EnvValidationError` со списком **всех** проблемных переменных, отчёт о деградациях.
- `packages/client/src/shared/config` — отдельная, намеренно маленькая схема окружения браузера.

**Тесты репозитория** (`test/**`)

- `test/repo` — состав workspace, направление зависимостей, контракт tsconfig, версии тулчейна.
- `test/env` — `.env.example` совпадает с объединением серверной и клиентской схем и переменных,
  которые интерполирует compose; в шаблоне нет реальных секретов; серверный секрет не может
  получить имя с префиксом `VITE_`.
- `test/infra` — инварианты `docker-compose.yml` и bootstrap-SQL.
- `test/lint` — архитектурные запреты проверяются линтом намеренно сломанных фикстур, с
  положительным контролем.

### Environment variables — EPIC-001

Полный шаблон — [`.env.example`](.env.example); нормативные описания —
[`docs/runbooks/install.md`](docs/runbooks/install.md). Ни одна из переменных ещё не читается
работающим приложением: сервер — скелет. Список приведён здесь, потому что этот файл — то, из чего
администратор self-host узнаёт об изменениях окружения.

**Обязательные, без значения по умолчанию — процесс не стартует без них:**

| Переменная | Что это |
|---|---|
| `APP_URL` | Публичный URL инсталляции: CORS, домен cookie, ссылки в письмах. В production обязан быть `https`, кроме loopback |
| `DATABASE_URL` | Строка подключения PostgreSQL для роли приложения (без `BYPASSRLS`) |
| `REDIS_URL` | Строка подключения Redis |
| `JWT_SECRET` | Секрет подписи access-токенов, минимум 32 символа (`openssl rand -base64 48`) |
| `APP_ENCRYPTION_KEY` | 32 байта в base64 (`openssl rand -base64 32`); шифрует секреты интеграций в БД. **Потеря делает их невосстановимыми** |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Объектное хранилище файлов |

**`NODE_ENV`** (по умолчанию `development`) стоит особняком: он не деградирует функцию, а решает,
запустится ли процесс вообще. Preflight включён на **всём, что не `development`** — включая `test`, —
и отвергает плейсхолдеры `CHANGE_ME`/`dev_` в секретах и `http`-`APP_URL` вне loopback. Область
выбрана по «не development», а не по «production» осознанно: модель угроз (T-SH-01, T-SH-03) считает
любой не-dev запуск доступным из интернета, и деплой, забытый на `NODE_ENV=test`, не должен
стартовать на плейсхолдерном секрете. Практическое следствие: `NODE_ENV=test` с dev-значениями
**ломает старт**, и это не регрессия.

**Опциональные — их отсутствие деградирует функцию, но не ломает старт:**

| Переменная | По умолчанию | Эффект |
|---|---|---|
| `PORT` | `3000` | Порт HTTP-сервера |
| `DATABASE_MIGRATION_URL` | нет | Подключение под ролью-владельцем для `prisma migrate deploy` и `pnpm db:grants`. Процесс приложения её не открывает, поэтому она опциональна для старта, но **миграции без неё не идут**: у `app_user` нет `CREATE` на схеме `public` |
| `S3_REGION` | `us-east-1` | Регион объектного хранилища |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style адресация для MinIO; для AWS S3 — `false` |
| `MEILI_HOST`, `MEILI_MASTER_KEY`, `MEILI_ENV` | нет | Без них поиск падает на PostgreSQL FTS. `MEILI_MASTER_KEY` обязателен, если задан `MEILI_HOST` |
| `SMTP_URL` | нет | Без неё письма пишутся в лог (dev) и падают с внятной ошибкой (prod) |
| `AI_ENABLED` | `false` | Ключи AI-провайдеров живут в БД, а не в env ([ADR-0014](docs/architecture/adr/0014-ai-provider-abstraction.md)) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | нет | Без неё трейсы не экспортируются; логи и метрики работают |
| `CORS_EXTRA_ORIGINS` | нет | Дополнительные origin'ы браузера через запятую, сверх `APP_URL` |
| `LOG_LEVEL` | `info` | `fatal`…`trace` |
| `RUN_WORKERS_IN_PROCESS` | `false` | Исключение для профиля `minimal`: воркеры в процессе API |
| `ARGON2_MEMORY_COST` | `19456` | Параметры argon2id для паролей. Значения `0`, отрицательные и дробные отвергаются на старте |
| `ARGON2_TIME_COST` | `2` | |
| `ARGON2_PARALLELISM` | `1` | |

**Браузерный бандл** (Vite инлайнит только префикс `VITE_`; серверных секретов здесь нет и быть не
может — это проверяется тестом):

| Переменная | По умолчанию | Что это |
|---|---|---|
| `VITE_API_BASE_URL` | `/api/v1` | Адрес API: путь того же origin или абсолютный `http(s)`-URL |

**Только для `docker compose` и скриптов разработки** — приложением не читаются, в production-образ
не попадают: `COMPOSE_PROFILES`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`POSTGRES_PORT`, `APP_MIGRATOR_PASSWORD`, `APP_USER_PASSWORD`, `APP_AUTH_PASSWORD`,
`BACKUP_ROLE_PASSWORD`, `REDIS_PORT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_PORT`,
`MINIO_CONSOLE_PORT`, `MEILI_PORT`, `MAILPIT_MAX_MESSAGES`, `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT`.

### Added — Phase 0: спецификация проекта

**Продуктовые документы** (`docs/product/`, 3 файла)

- `prd.md` — проблема и цель, персоны и JTBD, скоуп по MoSCoW, North Star Metric и контрметрики,
  риски R-01…R-15, явный out-of-scope.
- `roadmap.md` — девять майлстоунов M1–M9 с составом эпиков, пользовательской ценностью, критериями
  выхода и зависимостями.
- `glossary.md` — ubiquitous language EN/RU: термин домена = имя Prisma-модели = корень FSD-unit'а =
  имя в контракте API.

**Архитектурные документы** (`docs/architecture/`, 4 файла + 21 ADR)

- `overview.md` — C4 уровни 1–3, ограниченные контексты, сквозные механизмы (tenancy, авторизация,
  outbox, файлы, realtime, поиск, AI, observability), границы доверия, развёртывание.
- `stack.md` — стек с версиями и обоснованиями, раскладка монорепо, гексагональные слои сервера,
  contract-first API, работа с БД и RLS, outbox и очереди, безопасность в коде, конфигурация и env,
  наблюдаемость, тестовая стратегия, команды, политика зависимостей и лицензий.
- `data-model.md` — сущности, таблицы, индексы, RLS-политики; источник истины по именам.
- `ux-architecture.md` — принципы интерфейса, информационная архитектура, карта маршрутов, ключевые
  экраны, дизайн-система, паттерны взаимодействия, права в UI, доступность WCAG 2.1 AA, локализация,
  адаптивность и производительность.
- `adr/0001`…`adr/0021` — 21 запись Architecture Decision Record: монорепо, гексагональный backend,
  OpenAPI как источник истины, мультиарендность через RLS, FSD «units», Mantine + CSS Modules,
  TanStack Router и Query, модель прав RBAC + ACL, иерархия ключей E2EE, Socket.IO + Redis, поиск с
  учётом прав, редактор BlockNote, Markdown как источник истины KB, абстракция AI-провайдера,
  S3-хранилище и presigned URL, единая модель записи времени, Mantine Charts, лицензия AGPL-3.0,
  i18n EN/RU, упаковка для self-host, транзакционный outbox.

**Документы безопасности** (`docs/security/`, 4 файла)

- `threat-model.md` — область моделирования, активы, нарушители N1–N8, границы доверия, STRIDE по
  контекстам, топ-15 угроз, prompt injection, утечка через поиск, presigned URL, supply chain,
  специфика self-host, персональные данные, остаточные риски RR-01…RR-07, план проверки.
- `rls-design.md` — три роли БД и bootstrap, канонический шаблон политики, особые случаи
  (`organizations`, append-журналы, партиции, наследование `organization_id`, представления),
  `withTenant` и `guardedClient`, автоматизация против забывчивости, обязательные isolation-тесты,
  особые пути (логин, анонимная ссылка, воркеры), миграции и RLS, производительность, чек-лист
  «новая таблица», известные ограничения.
- `permission-model.md` — пять слоёв модели (каталог permissions, роли, per-user overrides, resource
  ACL, единая точка вычисления), матрица роль × endpoint, отвергнутые альтернативы.
- `e2ee-design.md` — обещание и его границы, иерархия ключей, параметры примитивов и защита от
  downgrade, что хранится на сервере и что не хранится никогда, полный жизненный цикл (регистрация,
  разблокировка, создание, чтение, шаринг, отзыв и ротация, смена и сброс пароля, офбординг,
  Recovery Kit, org escrow), blind index, защищённые ссылки ONE_TIME и RESTRICTED, интеграция с
  остальной системой, правила для разработчиков, модель угроз vault, план реализации.

**Правила разработки** (`rules/`, 34 файла `.mdc`)

Обязательные всегда (`alwaysApply: true`): `tdd-and-commit-gate`, `ci-before-push`, `commit-hygiene`,
`epic-driven-development`, `agent-orchestration`, `naming-and-structure`, `tenancy-rls`,
`permissions`, `security`, `i18n`, `a11y`, `frontend-fsd`, `hexagonal-backend`, `testing`.

По области изменений: `api-contract`, `zod-validation`, `db-migrations`, `outbox`,
`polymorphic-access`, `tanstack-query`, `lists-and-filters`, `design-system`, `errors-and-toasts`,
`editor-content`, `realtime`, `search-index`, `file-uploads`, `import-export`, `observability`,
`e2ee-crypto`, `ai-providers`, `time-tracking-invariants`, `self-host-packaging`, `dependencies`.

**Проектные агенты-ревьюеры** (`.claude/agents/`, 9 файлов)

`tenancy-rls-auditor`, `permission-matrix-auditor`, `e2ee-crypto-reviewer`,
`openapi-contract-guardian`, `fsd-architecture-linter`, `realtime-event-reviewer`,
`search-permission-auditor`, `i18n-coverage-checker`, `selfhost-upgrade-checker` — каждый только
читает дельту и отчитывается, код не редактирует.

**Декомпозиция работ** (`epics/`, 159 файлов)

- 46 эпиков (`epic.md`) — по одному на каталог `epic-NNN-<slug>/`, с frontmatter
  (`id`/`status`/`blocked`/`milestone`/`owner`), ценностью, scope in/out, критериями приёмки,
  зависимостями и рисками.
- 113 пользовательских историй (`stories/story-NNN-XX-<slug>.md`) — написаны для майлстоунов M1 и M2
  (эпики EPIC-001 … EPIC-017), с критериями Given/When/Then, чек-листом задач и Definition of Done.
  Истории майлстоунов M3–M9 создаются на kickoff соответствующего майлстоуна.

**Корневые документы и runbooks**

- `CLAUDE.md` — рабочее соглашение: три неприкосновенных инварианта, порядок источников истины,
  CI-before-push, карта «какой файл читать когда», стек, workflow эпиков, commit-гейт, команды,
  раскладка пакетов и нейминг, таблица проектных агентов, чувствительность данных.
- `README.md` и `README.ru.md` — публичное описание проекта на английском и русском с честным
  статусом фазы проектирования.
- `CONTRIBUTING.md` — окружение, структура репозитория, обязательный TDD, commit-гейт, Conventional
  Commits, обязательность `rules/*.mdc`, процесс эпиков и историй, код-ревью, DCO 1.1, Definition of
  Done (ключевые разделы продублированы по-русски).
- `SECURITY.md` — поддерживаемые версии, приватный канал приёма уязвимостей и сроки ответа, скоуп и
  out-of-scope, координированное раскрытие за 90 дней, раздел о гарантиях и не-гарантиях E2EE-vault,
  чек-лист безопасной self-host установки.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `CHANGELOG.md` — этот файл.
- `docs/README.md` — Map of Docs: карта всей документации, схема связей, разделение источников истины.
- `docs/api/README.md` — contract-first флоу, генерация типов, правила изменения контракта.
- `docs/runbooks/install.md`, `upgrade.md`, `backup-restore.md`, `incident.md` — операционные
  инструкции self-host: установка и чек-лист безопасности, обновление и откат, бэкап и
  восстановление, реакция на инциденты.

**Прочее в репозитории**

`LICENSE` (AGPL-3.0), `.editorconfig`, `.gitignore`, `.npmrc`, `.nvmrc` (Node 22).

### Not yet present

HTTP-сервер и `/health` (EPIC-003), Vite dev-server и клиентский шелл (EPIC-004),
`prisma/schema.prisma` и миграции (EPIC-003/005), `docs/api/openapi.yaml` (STORY-003-05),
`Dockerfile` и образ приложения (EPIC-017), CI-воркфлоу (EPIC-002 — в `.github/workflows/` пока
пусто). Всё перечисленное создаётся эпиками майлстоунов M1–M2.

---

<!--
  Release sections go here, newest first, e.g.:

  ## [0.1.0] — YYYY-MM-DD
  ### Added / Changed / Deprecated / Removed / Fixed / Security
  ### Environment variables
  ### Migration notes
-->
